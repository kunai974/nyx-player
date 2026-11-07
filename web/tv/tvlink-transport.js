// Connexion de la TV par QR code — envoi du paquet chiffré à la TV (côté téléphone).
// Messagerie instantanée de Supabase (Realtime « broadcast ») : le message passe à la TV qui écoute
// le canal, il n'est écrit nulle part. Protocole Phoenix minimal (rejoindre, envoyer, écouter la
// réponse), sans bibliothèque. Le paquet est déjà chiffré pour la TV : Supabase n'en voit que du bruit.

const ACK_TIMEOUT_MS = 30000;
// Après « la TV se connecte » : le temps de vérifier le fournisseur et de se connecter au compte
const WORKING_TIMEOUT_MS = 120000;

/**
 * Envoie `envelope` sur le canal de la TV et attend sa réponse ({ ok, reason? }). `onWorking` est
 * appelé quand la TV a ouvert le paquet et se connecte.
 * Rejette avec Error('timeout' | 'network' | 'join').
 */
export function sendToTv({ supabaseUrl, apiKey, channel, envelope, onWorking, timeoutMs = ACK_TIMEOUT_MS, workingTimeoutMs = WORKING_TIMEOUT_MS, WebSocketImpl = globalThis.WebSocket }) {
  return new Promise((resolve, reject) => {
    const wsUrl = supabaseUrl.replace(/^http/, 'ws').replace(/\/$/, '')
      + '/realtime/v1/websocket?apikey=' + encodeURIComponent(apiKey) + '&vsn=1.0.0';
    const topic = 'realtime:tvlink:' + channel;
    // Numéro de cet envoi : la TV le recopie dans ses réponses, celles d'un autre envoi sont ignorées
    const rid = Array.from(globalThis.crypto.getRandomValues(new Uint8Array(12)), (b) => b.toString(16).padStart(2, '0')).join('');
    let ref = 0;
    let joinRef = null;
    let done = false;
    let heartbeat = null;
    const ws = new WebSocketImpl(wsUrl);

    const finish = (fn, value) => {
      if (done) return;
      done = true;
      clearTimeout(timer);
      if (heartbeat) clearInterval(heartbeat);
      try { ws.close(); } catch { /* déjà fermé */ }
      fn(value);
    };
    const push = (t, event, payload) => {
      ref += 1;
      ws.send(JSON.stringify({ topic: t, event, payload, ref: String(ref), join_ref: t === topic ? joinRef : undefined }));
      return String(ref);
    };
    let timer = setTimeout(() => finish(reject, new Error('timeout')), timeoutMs);

    ws.onopen = () => {
      joinRef = String(ref + 1);
      push(topic, 'phx_join', {
        config: { broadcast: { ack: false, self: false }, presence: { key: '', enabled: false }, private: false },
      });
      heartbeat = setInterval(() => push('phoenix', 'heartbeat', {}), 25000);
    };
    ws.onerror = () => finish(reject, new Error('network'));
    ws.onclose = () => finish(reject, new Error('network'));
    ws.onmessage = (event) => {
      let msg;
      try { msg = JSON.parse(event.data); } catch { return; }
      if (msg.topic !== topic) return;
      if (msg.event === 'phx_reply' && msg.ref === joinRef) {
        if (msg.payload && msg.payload.status === 'ok') {
          push(topic, 'broadcast', { type: 'broadcast', event: 'seal', payload: { ...envelope, rid } });
        } else {
          finish(reject, new Error('join'));
        }
        return;
      }
      if (msg.event !== 'broadcast' || !msg.payload || !msg.payload.payload || msg.payload.payload.rid !== rid) return;
      if (msg.event === 'broadcast' && msg.payload && msg.payload.event === 'status'
        && msg.payload.payload && msg.payload.payload.step === 'working') {
        clearTimeout(timer);
        timer = setTimeout(() => finish(reject, new Error('timeout')), workingTimeoutMs);
        if (onWorking) onWorking();
        return;
      }
      if (msg.event === 'broadcast' && msg.payload && msg.payload.event === 'ack') {
        const ack = msg.payload.payload || {};
        finish(resolve, { ok: ack.ok === true, reason: typeof ack.reason === 'string' ? ack.reason : undefined });
      }
    };
  });
}
