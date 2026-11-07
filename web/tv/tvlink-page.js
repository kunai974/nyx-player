// Page ouverte par le QR code de la TV (nyxplayer.app/tv/#v=1&c=…&k=…&m=a|p).
// La partie après « # » n'est jamais envoyée au site ; elle est lue une fois puis retirée de
// l'adresse. Les saisies sont chiffrées ici pour la TV seule (tvlink-crypto.js), puis envoyées par
// la messagerie instantanée de Supabase (tvlink-transport.js) : rien n'est enregistré, ni chez Nyx
// ni sur ce téléphone.

import { parseTvLinkFragment, sealForTv } from './tvlink-crypto.js';
import { sendToTv } from './tvlink-transport.js';

const TEXTS = {
    en: {
        title: 'Connect your TV — Nyx Player',
        subtitle: 'Connect your TV',
        invalid: 'This link is incomplete. Scan the QR code shown on your TV again.',
        accountTitle: 'Your Nyx account',
        email: 'Email',
        password: 'Password',
        providerTitle: 'Your IPTV provider',
        optional: '(optional)',
        tabXtream: 'Xtream Codes',
        tabM3u: 'M3U link',
        host: 'Server address',
        username: 'Username',
        m3u: 'M3U playlist link',
        send: 'Send to my TV',
        privacy: 'Encrypted on this phone for your TV only: our servers pass it on without being able to read it. This page keeps nothing.',
        sending: 'Sending to your TV…',
        working: 'Your TV is checking and signing in…',
        errBusy: 'Your TV is busy signing in. Wait a moment, then send again.',
        errClosed: 'This code is no longer valid. Show a new code on the TV and scan it again.',
        done: '✓ Sent! Look at your TV, it is signing in. You can close this page.',
        errAccountMissing: 'Enter your email and password.',
        errEmail: 'This email address looks incomplete: check it, then send again.',
        errProviderMissing: 'Fill in your provider (server address, username and password, or an M3U link).',
        errAccount: 'Your TV could not sign in: check your email and password, then send again.',
        errProvider: 'Your provider refused this username or password: check them, then send again.',
        errProviderFormat: 'These provider details are incomplete or the link is not valid: check them, then send again.',
        errProviderUnreachable: 'Your TV could not reach this provider’s server: check the address, or try again later.',
        errProviderInactive: 'Your provider says this subscription is expired or suspended.',
        errUnreadable: 'This QR code no longer matches your TV. Show a new code on the TV and scan it again.',
        errTimeout: 'Your TV did not answer. Check that the QR code is still shown on the TV, then send again.',
        errNetwork: 'Network error. Check your connection, then send again.',
        errGeneric: 'Something went wrong. Send again, or show a new code on the TV.',
    },
    fr: {
        title: 'Connecter votre TV — Nyx Player',
        subtitle: 'Connecter votre TV',
        invalid: 'Ce lien est incomplet. Scannez de nouveau le QR code affiché sur votre TV.',
        accountTitle: 'Votre compte Nyx',
        email: 'E-mail',
        password: 'Mot de passe',
        providerTitle: 'Votre fournisseur IPTV',
        optional: '(facultatif)',
        tabXtream: 'Xtream Codes',
        tabM3u: 'Lien M3U',
        host: 'Adresse du serveur',
        username: 'Identifiant',
        m3u: 'Lien de la liste M3U',
        send: 'Envoyer à ma TV',
        privacy: 'Chiffré sur ce téléphone pour votre TV seule : nos serveurs le transmettent sans pouvoir le lire. Cette page ne garde rien.',
        sending: 'Envoi à votre TV…',
        working: 'Votre TV vérifie et se connecte…',
        errBusy: 'Votre TV est déjà en train de se connecter. Patientez un instant, puis renvoyez.',
        errClosed: 'Ce code n’est plus valable. Affichez un nouveau code sur la TV et scannez-le.',
        done: '✓ Envoyé ! Regardez votre TV, elle se connecte. Vous pouvez fermer cette page.',
        errAccountMissing: 'Saisissez votre e-mail et votre mot de passe.',
        errEmail: 'Cette adresse e-mail semble incomplète : vérifiez-la, puis renvoyez.',
        errProviderMissing: 'Remplissez votre fournisseur (adresse du serveur, identifiant et mot de passe, ou un lien M3U).',
        errAccount: 'Votre TV n’a pas pu se connecter : vérifiez l’e-mail et le mot de passe, puis renvoyez.',
        errProvider: 'Votre fournisseur a refusé cet identifiant ou ce mot de passe : vérifiez-les, puis renvoyez.',
        errProviderFormat: 'Les informations du fournisseur sont incomplètes ou le lien n’est pas valide : vérifiez-les, puis renvoyez.',
        errProviderUnreachable: 'Votre TV n’a pas pu joindre le serveur de ce fournisseur : vérifiez l’adresse, ou réessayez plus tard.',
        errProviderInactive: 'Votre fournisseur indique que cet abonnement est expiré ou suspendu.',
        errUnreadable: 'Ce QR code ne correspond plus à votre TV. Affichez un nouveau code sur la TV et scannez-le.',
        errTimeout: 'Votre TV n’a pas répondu. Vérifiez que le QR code est toujours affiché, puis renvoyez.',
        errNetwork: 'Erreur réseau. Vérifiez votre connexion, puis renvoyez.',
        errGeneric: 'Un problème est survenu. Renvoyez, ou affichez un nouveau code sur la TV.',
    },
};

function pickLanguage() {
    const asked = new URLSearchParams(location.search).get('lang');
    if (asked === 'fr' || asked === 'en') return asked;
    for (const l of navigator.languages || [navigator.language || '']) {
        const base = String(l).slice(0, 2).toLowerCase();
        if (base === 'fr' || base === 'en') return base;
    }
    return 'en';
}

let lang = pickLanguage();
const $ = (id) => document.getElementById(id);

function applyTexts() {
    const t = TEXTS[lang];
    document.documentElement.lang = lang;
    document.title = t.title;
    for (const el of document.querySelectorAll('[data-t]')) el.textContent = t[el.dataset.t] || '';
    for (const b of document.querySelectorAll('.lang-switch__option')) {
        b.classList.toggle('lang-switch__option--current', b.dataset.lang === lang);
        b.setAttribute('aria-pressed', String(b.dataset.lang === lang));
    }
    if (currentError) showError(currentError);
}

let currentError = null;
function showError(key) {
    currentError = key;
    const box = $('form-error');
    box.textContent = TEXTS[lang][key] || TEXTS[lang].errGeneric;
    box.classList.remove('hidden');
}
function hideError() {
    currentError = null;
    $('form-error').classList.add('hidden');
}

function show(id) {
    for (const s of ['state-invalid', 'state-form', 'state-sending', 'state-done']) $(s).classList.toggle('hidden', s !== id);
}

// Lien du QR code : lu une fois, puis retiré de l'adresse (ni historique, ni partage par erreur)
const link = parseTvLinkFragment(location.hash);
if (location.hash) history.replaceState(null, '', location.pathname + location.search);

let providerType = 'xtream';
function setProviderType(type) {
    providerType = type;
    $('tab-xtream').setAttribute('aria-pressed', String(type === 'xtream'));
    $('tab-m3u').setAttribute('aria-pressed', String(type === 'm3u'));
    $('fields-xtream').classList.toggle('hidden', type !== 'xtream');
    $('fields-m3u').classList.toggle('hidden', type !== 'm3u');
}

function readProvider() {
    if (providerType === 'm3u') {
        const value = $('m3u').value.trim();
        return value ? { type: 'm3u', link: value } : null;
    }
    const host = $('host').value.trim();
    const username = $('username').value.trim();
    const password = $('provider-password').value;
    if (!host && !username && !password) return null;
    return { type: 'xtream', host, username, password };
}

async function onSubmit(event) {
    event.preventDefault();
    hideError();
    const payload = {};
    if (link.mode === 'account') {
        const email = $('email').value.trim();
        const password = $('password').value;
        if (!email || !password) return showError('errAccountMissing');
        // Même contrôle que la TV (qui refuserait sinon le paquet sans dire pourquoi)
        if (email.length > 254 || !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) return showError('errEmail');
        payload.account = { email, password };
    }
    const provider = readProvider();
    if (provider && provider.type === 'xtream' && (!provider.host || ((!provider.username || !provider.password) && !/[?&]username=/.test(provider.host)))) {
        return showError('errProviderMissing');
    }
    if (provider) payload.provider = provider;
    if (link.mode === 'provider' && !provider) return showError('errProviderMissing');

    show('state-sending');
    $('sending-text').textContent = TEXTS[lang].sending;
    try {
        const envelope = await sealForTv(link.key, link.channel, link.mode, JSON.stringify(payload));
        const ack = await sendToTv({
            supabaseUrl: window.NYX_SUPABASE.url,
            apiKey: window.NYX_SUPABASE.key,
            channel: link.channel,
            envelope,
            onWorking: () => { $('sending-text').textContent = TEXTS[lang].working; },
        });
        if (ack.ok) {
            show('state-done');
            // Les saisies ne restent pas dans la page
            $('state-form').reset();
            return;
        }
        show('state-form');
        showError({
            account: 'errAccount',
            provider: 'errProvider',
            'provider-format': 'errProviderFormat',
            'provider-unreachable': 'errProviderUnreachable',
            'provider-inactive': 'errProviderInactive',
            unreadable: 'errUnreadable',
            busy: 'errBusy',
            closed: 'errClosed',
        }[ack.reason] || 'errGeneric');
    } catch (err) {
        show('state-form');
        showError(err && err.message === 'timeout' ? 'errTimeout' : 'errNetwork');
    }
}

for (const b of document.querySelectorAll('.lang-switch__option')) {
    b.addEventListener('click', () => { lang = b.dataset.lang; applyTexts(); });
}
applyTexts();

if (!link || !globalThis.crypto || !globalThis.crypto.subtle) {
    show('state-invalid');
} else {
    $('section-account').classList.toggle('hidden', link.mode !== 'account');
    $('provider-optional').classList.toggle('hidden', link.mode !== 'account');
    $('tab-xtream').addEventListener('click', () => setProviderType('xtream'));
    $('tab-m3u').addEventListener('click', () => setProviderType('m3u'));
    $('state-form').addEventListener('submit', (e) => void onSubmit(e));
    show('state-form');
}
