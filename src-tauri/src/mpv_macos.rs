//! macOS player: libmpv runs inside the app and draws through its render API into an
//! `NSOpenGLView` placed *under* the transparent WKWebView (the page's controls stay on top).
//!
//! Why not the Windows approach (mpv.exe child process + `--wid`)? mpv ignores `--wid` on macOS and
//! opens its own window. Here no second process or window exists.
//!
//! Same contract as the Windows path for the web side: `nyx_mpv_*` commands (mpv_guard.rs), and
//! `mpv-event-<window>` events with the JSON shape of mpv's IPC (`event`, `name`, `data`, `reason`).

use serde_json::{json, Map, Value};
use std::ffi::{c_char, c_int, c_void, CStr, CString};
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::{Arc, Mutex, OnceLock};

use objc2::encode::{Encode, Encoding};
use objc2::msg_send;
use objc2::runtime::{AnyObject, Bool};
use tauri::Emitter;

type Handle = *mut c_void;

// ---------------------------------------------------------------------------------------------
// libmpv C API (loaded at runtime: the app starts even when libmpv is missing)
// ---------------------------------------------------------------------------------------------

const FORMAT_NODE: c_int = 6;
const EVENT_SHUTDOWN: c_int = 1;
const EVENT_START_FILE: c_int = 6;
const EVENT_END_FILE: c_int = 7;
const EVENT_FILE_LOADED: c_int = 8;
const EVENT_SEEK: c_int = 20;
const EVENT_PLAYBACK_RESTART: c_int = 21;
const EVENT_PROPERTY_CHANGE: c_int = 22;
const RENDER_API_TYPE: c_int = 1;
const RENDER_OPENGL_INIT_PARAMS: c_int = 2;
const RENDER_OPENGL_FBO: c_int = 3;
const RENDER_FLIP_Y: c_int = 4;
const RENDER_BLOCK_FOR_TARGET_TIME: c_int = 12;

#[repr(C)]
struct RenderParam {
    kind: c_int,
    data: *mut c_void,
}

#[repr(C)]
struct GlInitParams {
    get_proc_address: extern "C" fn(*mut c_void, *const c_char) -> *mut c_void,
    ctx: *mut c_void,
}

#[repr(C)]
struct GlFbo {
    fbo: c_int,
    w: c_int,
    h: c_int,
    internal_format: c_int,
}

#[repr(C)]
struct RawEvent {
    event_id: c_int,
    error: c_int,
    reply_userdata: u64,
    data: *mut c_void,
}

#[repr(C)]
struct RawEventProperty {
    name: *const c_char,
    format: c_int,
    data: *mut c_void,
}

#[repr(C)]
struct RawEventEndFile {
    reason: c_int,
    error: c_int,
}

#[repr(C)]
union NodeValue {
    string: *mut c_char,
    flag: c_int,
    int64: i64,
    double: f64,
    list: *mut NodeList,
    other: *mut c_void,
}

#[repr(C)]
struct Node {
    value: NodeValue,
    format: c_int,
}

#[repr(C)]
struct NodeList {
    num: c_int,
    values: *mut Node,
    keys: *mut *mut c_char,
}

struct Api {
    _lib: libloading::Library,
    create: unsafe extern "C" fn() -> Handle,
    initialize: unsafe extern "C" fn(Handle) -> c_int,
    set_option_string: unsafe extern "C" fn(Handle, *const c_char, *const c_char) -> c_int,
    set_property_string: unsafe extern "C" fn(Handle, *const c_char, *const c_char) -> c_int,
    command: unsafe extern "C" fn(Handle, *mut *const c_char) -> c_int,
    get_property: unsafe extern "C" fn(Handle, *const c_char, c_int, *mut c_void) -> c_int,
    observe_property: unsafe extern "C" fn(Handle, u64, *const c_char, c_int) -> c_int,
    wait_event: unsafe extern "C" fn(Handle, f64) -> *mut RawEvent,
    free_node_contents: unsafe extern "C" fn(*mut Node),
    error_string: unsafe extern "C" fn(c_int) -> *const c_char,
    render_create: unsafe extern "C" fn(*mut Handle, Handle, *mut RenderParam) -> c_int,
    render_set_update_callback:
        unsafe extern "C" fn(Handle, Option<extern "C" fn(*mut c_void)>, *mut c_void),
    render_update: unsafe extern "C" fn(Handle) -> u64,
    render_render: unsafe extern "C" fn(Handle, *mut RenderParam) -> c_int,
}

const LIB_CANDIDATES: &[&str] = &[
    "@executable_path/../Frameworks/libmpv.2.dylib",
    "/opt/homebrew/lib/libmpv.2.dylib",
    "/opt/homebrew/lib/libmpv.dylib",
    "/usr/local/lib/libmpv.2.dylib",
    "/usr/local/lib/libmpv.dylib",
];

fn load_api() -> Result<Api, String> {
    let lib = LIB_CANDIDATES
        .iter()
        // SAFETY: loading a system library by absolute path; no initialiser of ours runs.
        .find_map(|p| unsafe { libloading::Library::new(p).ok() })
        .ok_or_else(|| "mpv process failed: libmpv not found (brew install mpv)".to_string())?;
    macro_rules! sym {
        ($name:literal) => {
            // SAFETY: the symbol types match the libmpv C headers (client.h, render.h).
            *unsafe { lib.get(concat!($name, "\0").as_bytes()) }
                .map_err(|e| format!("mpv process failed: {} missing ({e})", $name))?
        };
    }
    Ok(Api {
        create: sym!("mpv_create"),
        initialize: sym!("mpv_initialize"),
        set_option_string: sym!("mpv_set_option_string"),
        set_property_string: sym!("mpv_set_property_string"),
        command: sym!("mpv_command"),
        get_property: sym!("mpv_get_property"),
        observe_property: sym!("mpv_observe_property"),
        wait_event: sym!("mpv_wait_event"),
        free_node_contents: sym!("mpv_free_node_contents"),
        error_string: sym!("mpv_error_string"),
        render_create: sym!("mpv_render_context_create"),
        render_set_update_callback: sym!("mpv_render_context_set_update_callback"),
        render_update: sym!("mpv_render_context_update"),
        render_render: sym!("mpv_render_context_render"),
        _lib: lib,
    })
}

// ---------------------------------------------------------------------------------------------
// AppKit geometry (own types: only the encoding is needed for msg_send)
// ---------------------------------------------------------------------------------------------

#[repr(C)]
#[derive(Clone, Copy)]
struct Point {
    x: f64,
    y: f64,
}
#[repr(C)]
#[derive(Clone, Copy)]
struct Size {
    w: f64,
    h: f64,
}
#[repr(C)]
#[derive(Clone, Copy)]
struct Rect {
    origin: Point,
    size: Size,
}
// SAFETY: same layout and encoding as CGPoint / CGSize / CGRect.
unsafe impl Encode for Point {
    const ENCODING: Encoding = Encoding::Struct("CGPoint", &[f64::ENCODING, f64::ENCODING]);
}
unsafe impl Encode for Size {
    const ENCODING: Encoding = Encoding::Struct("CGSize", &[f64::ENCODING, f64::ENCODING]);
}
unsafe impl Encode for Rect {
    const ENCODING: Encoding = Encoding::Struct("CGRect", &[Point::ENCODING, Size::ENCODING]);
}

// ---------------------------------------------------------------------------------------------
// Player state
// ---------------------------------------------------------------------------------------------

struct Player {
    api: Api,
    mpv: Handle,
    render: Handle,
    /// `NSOpenGLView*` and its `NSOpenGLContext*` (main thread only)
    view: *mut AnyObject,
    gl: *mut AnyObject,
    label: String,
    alive: AtomicBool,
    redraw_queued: AtomicBool,
    last_size: Mutex<(i32, i32)>,
}

// SAFETY: libmpv handles are thread-safe; the AppKit pointers are only dereferenced on the main
// thread (`render_frame`, `init`).
unsafe impl Send for Player {}
unsafe impl Sync for Player {}

static PLAYER: Mutex<Option<Arc<Player>>> = Mutex::new(None);

fn current() -> Option<Arc<Player>> {
    PLAYER.lock().ok().and_then(|p| p.clone())
}

fn c(text: &str) -> Result<CString, String> {
    CString::new(text).map_err(|_| "mpv process failed: invalid text".to_string())
}

impl Player {
    fn error_text(&self, code: c_int) -> String {
        // SAFETY: mpv_error_string returns a static NUL-terminated string.
        unsafe { CStr::from_ptr((self.api.error_string)(code)) }.to_string_lossy().into_owned()
    }

    fn command(&self, args: &[String]) -> Result<(), String> {
        let owned: Vec<CString> = args.iter().map(|a| c(a)).collect::<Result<_, _>>()?;
        let mut ptrs: Vec<*const c_char> = owned.iter().map(|s| s.as_ptr()).collect();
        ptrs.push(std::ptr::null());
        // SAFETY: NULL-terminated array of valid C strings, alive during the call.
        let code = unsafe { (self.api.command)(self.mpv, ptrs.as_mut_ptr()) };
        if code < 0 { Err(self.error_text(code)) } else { Ok(()) }
    }

    fn set_property(&self, name: &str, value: &str) -> Result<(), String> {
        let (n, v) = (c(name)?, c(value)?);
        // SAFETY: valid C strings.
        let code = unsafe { (self.api.set_property_string)(self.mpv, n.as_ptr(), v.as_ptr()) };
        if code < 0 { Err(self.error_text(code)) } else { Ok(()) }
    }

    fn get_property(&self, name: &str) -> Result<Value, String> {
        let n = c(name)?;
        let mut node = Node { value: NodeValue { int64: 0 }, format: 0 };
        // SAFETY: FORMAT_NODE writes an mpv_node into `node`; freed right after conversion.
        unsafe {
            let code = (self.api.get_property)(self.mpv, n.as_ptr(), FORMAT_NODE, &mut node as *mut Node as *mut c_void);
            if code < 0 {
                return Err(self.error_text(code));
            }
            let value = node_to_json(&node);
            (self.api.free_node_contents)(&mut node);
            Ok(value)
        }
    }
}

/// mpv_node → JSON (same values as mpv's JSON IPC)
unsafe fn node_to_json(node: &Node) -> Value {
    match node.format {
        1 | 2 => {
            if node.value.string.is_null() { Value::Null }
            else { Value::String(CStr::from_ptr(node.value.string).to_string_lossy().into_owned()) }
        }
        3 => Value::Bool(node.value.flag != 0),
        4 => json!(node.value.int64),
        5 => serde_json::Number::from_f64(node.value.double).map(Value::Number).unwrap_or(Value::Null),
        7 | 8 => {
            let list = node.value.list;
            if list.is_null() { return Value::Null; }
            let list = &*list;
            let count = list.num.max(0) as usize;
            let values = (0..count).map(|i| node_to_json(&*list.values.add(i)));
            if node.format == 7 {
                Value::Array(values.collect())
            } else {
                let mut map = Map::new();
                for (i, value) in values.enumerate() {
                    let key = CStr::from_ptr(*list.keys.add(i)).to_string_lossy().into_owned();
                    map.insert(key, value);
                }
                Value::Object(map)
            }
        }
        _ => Value::Null,
    }
}

// ---------------------------------------------------------------------------------------------
// OpenGL view (main thread)
// ---------------------------------------------------------------------------------------------

extern "C" fn get_proc_address(_ctx: *mut c_void, name: *const c_char) -> *mut c_void {
    static GL: OnceLock<Option<libloading::os::unix::Library>> = OnceLock::new();
    let lib = GL.get_or_init(|| {
        // SAFETY: system framework.
        unsafe { libloading::os::unix::Library::open(Some("/System/Library/Frameworks/OpenGL.framework/OpenGL"), libc_rtld_lazy()).ok() }
    });
    let Some(lib) = lib else { return std::ptr::null_mut() };
    // SAFETY: `name` is a NUL-terminated GL symbol name given by libmpv.
    let bytes = unsafe { CStr::from_ptr(name) }.to_bytes_with_nul();
    unsafe { lib.get::<*mut c_void>(bytes).map(|s| *s).unwrap_or(std::ptr::null_mut()) }
}

fn libc_rtld_lazy() -> i32 {
    1 // RTLD_LAZY
}

/// Draws one frame into the GL view. `force`: redraw even without a new frame (resize).
fn render_frame(player: &Player, force: bool) {
    // SAFETY: main thread; pointers created in `build_view` and never freed.
    unsafe {
        let flags = (player.api.render_update)(player.render);
        if !force && flags & 1 == 0 {
            return;
        }
        let _: () = msg_send![player.gl, makeCurrentContext];
        let bounds: Rect = msg_send![player.view, bounds];
        let backing: Rect = msg_send![player.view, convertRectToBacking: bounds];
        let (w, h) = (backing.size.w as i32, backing.size.h as i32);
        if w <= 0 || h <= 0 {
            return;
        }
        if let Ok(mut last) = player.last_size.lock() {
            *last = (w, h);
        }
        let mut fbo = GlFbo { fbo: 0, w, h, internal_format: 0 };
        let mut flip: c_int = 1;
        let mut block: c_int = 0; // never sleep inside the render call: this is the UI thread
        let mut params = [
            RenderParam { kind: RENDER_BLOCK_FOR_TARGET_TIME, data: &mut block as *mut c_int as *mut c_void },
            RenderParam { kind: RENDER_OPENGL_FBO, data: &mut fbo as *mut GlFbo as *mut c_void },
            RenderParam { kind: RENDER_FLIP_Y, data: &mut flip as *mut c_int as *mut c_void },
            RenderParam { kind: 0, data: std::ptr::null_mut() },
        ];
        (player.api.render_render)(player.render, params.as_mut_ptr());
        let _: () = msg_send![player.gl, flushBuffer];
    }
}

/// Creates the GL view below the web view. Returns (view, context).
///
/// SAFETY: must run on the main thread with a live NSWindow pointer.
unsafe fn build_view(ns_window: *mut AnyObject) -> Result<(*mut AnyObject, *mut AnyObject), String> {
    let content: *mut AnyObject = msg_send![ns_window, contentView];
    if content.is_null() {
        return Err("mpv process failed: window has no content view".to_string());
    }
    // The WKWebView is the content view's subview whose class name contains "WKWebView"
    let subviews: *mut AnyObject = msg_send![content, subviews];
    let count: usize = msg_send![subviews, count];
    let mut webview: *mut AnyObject = std::ptr::null_mut();
    for i in 0..count {
        let v: *mut AnyObject = msg_send![subviews, objectAtIndex: i];
        let name: *mut AnyObject = msg_send![v, className];
        let utf8: *const c_char = msg_send![name, UTF8String];
        if !utf8.is_null() && CStr::from_ptr(utf8).to_string_lossy().contains("WebView") {
            webview = v;
            break;
        }
    }

    // NSOpenGLPFADoubleBuffer, NSOpenGLPFAOpenGLProfile = 3.2 core, end
    let attrs: [u32; 4] = [5, 99, 0x3200, 0];
    let pf: *mut AnyObject = msg_send![objc2::class!(NSOpenGLPixelFormat), alloc];
    let pf: *mut AnyObject = msg_send![pf, initWithAttributes: attrs.as_ptr()];
    if pf.is_null() {
        return Err("mpv process failed: no OpenGL pixel format".to_string());
    }
    let bounds: Rect = msg_send![content, bounds];
    let view: *mut AnyObject = msg_send![objc2::class!(NSOpenGLView), alloc];
    let view: *mut AnyObject = msg_send![view, initWithFrame: bounds, pixelFormat: pf];
    if view.is_null() {
        return Err("mpv process failed: OpenGL view failed".to_string());
    }
    let _: () = msg_send![view, setWantsBestResolutionOpenGLSurface: Bool::YES];
    let _: () = msg_send![view, setAutoresizingMask: 18usize]; // width + height sizable
    // Below every sibling (relativeTo: nil with NSWindowBelow = -1): the web view, whatever its class
    // is called, stays on top and keeps the mouse
    let _: () = msg_send![content, addSubview: view, positioned: -1isize, relativeTo: std::ptr::null_mut::<AnyObject>()];
    log::info!("[mpv-macos] video view added below {count} sibling view(s), web view found by name: {}", !webview.is_null());
    let gl: *mut AnyObject = msg_send![view, openGLContext];
    let _: () = msg_send![gl, makeCurrentContext];
    let interval: i32 = 1;
    // NSOpenGLCPSwapInterval = 222
    let _: () = msg_send![gl, setValues: &interval as *const i32, forParameter: 222isize];
    Ok((view, gl))
}

// ---------------------------------------------------------------------------------------------
// Events
// ---------------------------------------------------------------------------------------------

fn event_json(player: &Player, ev: &RawEvent) -> Option<Value> {
    // SAFETY: payload types follow ev.event_id (client.h).
    unsafe {
        match ev.event_id {
            EVENT_START_FILE => Some(json!({"event": "start-file"})),
            EVENT_FILE_LOADED => Some(json!({"event": "file-loaded"})),
            EVENT_SEEK => Some(json!({"event": "seek"})),
            EVENT_PLAYBACK_RESTART => Some(json!({"event": "playback-restart"})),
            EVENT_SHUTDOWN => Some(json!({"event": "shutdown"})),
            EVENT_END_FILE => {
                let end = &*(ev.data as *const RawEventEndFile);
                let reason = match end.reason {
                    0 => "eof",
                    2 => "stop",
                    3 => "quit",
                    4 => "error",
                    5 => "redirect",
                    _ => "unknown",
                };
                let mut out = json!({"event": "end-file", "reason": reason});
                if end.error < 0 {
                    out["file_error"] = Value::String(player.error_text(end.error));
                }
                Some(out)
            }
            EVENT_PROPERTY_CHANGE => {
                let prop = &*(ev.data as *const RawEventProperty);
                let name = CStr::from_ptr(prop.name).to_string_lossy().into_owned();
                let mut out = json!({"event": "property-change", "id": ev.reply_userdata, "name": name});
                if prop.format == FORMAT_NODE && !prop.data.is_null() {
                    out["data"] = node_to_json(&*(prop.data as *const Node));
                }
                Some(out)
            }
            _ => None,
        }
    }
}

fn spawn_event_thread(app: tauri::AppHandle, player: Arc<Player>) {
    std::thread::spawn(move || {
        let event_name = format!("mpv-event-{}", player.label);
        let mut sent = 0u32;
        let mut seen_pos = false;
        loop {
            // SAFETY: wait_event returns a pointer valid until the next call on this handle.
            let ev = unsafe { &*(player.api.wait_event)(player.mpv, 0.5) };
            if ev.event_id == EVENT_SHUTDOWN {
                player.alive.store(false, Ordering::SeqCst);
            }
            if let Some(payload) = event_json(&player, ev) {
                sent += 1;
                let first_pos = !seen_pos && payload["name"] == "time-pos" && payload.get("data").is_some();
                seen_pos |= first_pos;
                if sent <= 8 || first_pos {
                    log::info!("[mpv-macos] event #{sent} -> {event_name}: {payload}");
                }
                if let Err(e) = app.emit(&event_name, payload) {
                    log::warn!("[mpv-macos] emit failed: {e}");
                }
            }
            if !player.alive.load(Ordering::SeqCst) {
                break;
            }
        }
    });
}

extern "C" {
    static _dispatch_main_q: c_void;
    fn dispatch_async_f(queue: *const c_void, context: *mut c_void, work: extern "C" fn(*mut c_void));
}

extern "C" fn draw_on_main(ctx: *mut c_void) {
    // SAFETY: `ctx` is the Box<Arc<Player>> leaked by `on_render_update`
    let player = unsafe { Box::from_raw(ctx as *mut Arc<Player>) };
    player.redraw_queued.store(false, Ordering::SeqCst);
    render_frame(&player, false);
}

/// Redraw requests from libmpv are folded into one pending main-thread draw.
///
/// libmpv may call this from inside `mpv_render_context_render` itself, on the main thread. It must
/// therefore NEVER draw inline (that re-enters the render call and deadlocks the app, "not
/// responding"): `dispatch_async_f` always queues, even when already on the main thread
/// (tauri's `run_on_main_thread` runs the closure immediately there).
extern "C" fn on_render_update(_ctx: *mut c_void) {
    let Some(player) = current() else { return };
    if player.redraw_queued.swap(true, Ordering::SeqCst) {
        return;
    }
    let ctx = Box::into_raw(Box::new(player)) as *mut c_void;
    // SAFETY: the main queue lives for the whole process; `draw_on_main` frees `ctx`.
    unsafe { dispatch_async_f(&_dispatch_main_q as *const c_void, ctx, draw_on_main) };
}

static APP: OnceLock<tauri::AppHandle> = OnceLock::new();
static INIT_LOCK: tokio::sync::Mutex<()> = tokio::sync::Mutex::const_new(());

// ---------------------------------------------------------------------------------------------
// Commands (called from mpv_guard.rs after validation)
// ---------------------------------------------------------------------------------------------

fn to_arg(value: &Value) -> String {
    match value {
        Value::String(s) => s.clone(),
        Value::Bool(true) => "yes".to_string(),
        Value::Bool(false) => "no".to_string(),
        other => other.to_string(),
    }
}

/// Starts libmpv for the window (or reuses the running one).
pub async fn init(
    app: tauri::AppHandle,
    window: tauri::Window,
    args: Vec<String>,
    observed: Vec<String>,
) -> Result<String, String> {
    // The web side may call init twice at once: only one libmpv + view may ever be created
    let _starting = INIT_LOCK.lock().await;
    if current().is_some_and(|p| p.alive.load(Ordering::SeqCst)) {
        return Ok("mpv already running".to_string());
    }
    let _ = APP.set(app.clone());
    let label = window.label().to_string();
    let ns_window = window.ns_window().map_err(|e| format!("mpv process failed: {e}"))? as usize;

    let (tx, rx) = std::sync::mpsc::channel::<Result<Arc<Player>, String>>();
    let handle = app.clone();
    app.run_on_main_thread(move || {
        let _ = tx.send(start_on_main(handle, ns_window, label, args, observed));
    })
    .map_err(|e| format!("mpv process failed: {e}"))?;

    let player = tauri::async_runtime::spawn_blocking(move || rx.recv())
        .await
        .map_err(|_| "mpv process failed: init interrupted".to_string())?
        .map_err(|_| "mpv process failed: init interrupted".to_string())??;

    if let Ok(mut slot) = PLAYER.lock() {
        *slot = Some(player.clone());
    }
    spawn_event_thread(app.clone(), player.clone());
    spawn_resize_watcher(app, player);
    Ok("mpv started".to_string())
}

fn start_on_main(
    app: tauri::AppHandle,
    ns_window: usize,
    label: String,
    args: Vec<String>,
    observed: Vec<String>,
) -> Result<Arc<Player>, String> {
    let api = load_api()?;
    // SAFETY: libmpv C API as documented; main thread.
    unsafe {
        let mpv = (api.create)();
        if mpv.is_null() {
            return Err("mpv process failed: mpv_create".to_string());
        }
        let set = |name: &str, value: &str| {
            if let (Ok(n), Ok(v)) = (CString::new(name), CString::new(value)) {
                let code = (api.set_option_string)(mpv, n.as_ptr(), v.as_ptr());
                if code < 0 {
                    log::warn!("[mpv-macos] option {name} refused ({code})");
                }
            }
        };
        set("vo", "libmpv");
        set("idle", "yes");
        for arg in &args {
            let Some(option) = arg.strip_prefix("--") else { continue };
            let (name, value) = option.split_once('=').unwrap_or((option, "yes"));
            // Window options belong to the Windows child process; the video goes to our view
            if matches!(name, "vo" | "wid" | "force-window") {
                continue;
            }
            set(name, value);
        }
        let code = (api.initialize)(mpv);
        if code < 0 {
            let text = CStr::from_ptr((api.error_string)(code)).to_string_lossy().into_owned();
            return Err(format!("mpv process failed: initialize ({text})"));
        }

        let (view, gl) = build_view(ns_window as *mut AnyObject)?;

        let mut init = GlInitParams { get_proc_address, ctx: std::ptr::null_mut() };
        let api_type = CString::new("opengl").unwrap();
        let mut params = [
            RenderParam { kind: RENDER_API_TYPE, data: api_type.as_ptr() as *mut c_void },
            RenderParam { kind: RENDER_OPENGL_INIT_PARAMS, data: &mut init as *mut GlInitParams as *mut c_void },
            RenderParam { kind: 0, data: std::ptr::null_mut() },
        ];
        let mut render: Handle = std::ptr::null_mut();
        let code = (api.render_create)(&mut render, mpv, params.as_mut_ptr());
        if code < 0 {
            let text = CStr::from_ptr((api.error_string)(code)).to_string_lossy().into_owned();
            return Err(format!("mpv process failed: render context ({text})"));
        }

        for (id, name) in observed.iter().enumerate() {
            if let Ok(n) = CString::new(name.as_str()) {
                (api.observe_property)(mpv, id as u64 + 1, n.as_ptr(), FORMAT_NODE);
            }
        }

        let player = Arc::new(Player {
            api,
            mpv,
            render,
            view,
            gl,
            label,
            alive: AtomicBool::new(true),
            redraw_queued: AtomicBool::new(false),
            last_size: Mutex::new((0, 0)),
        });
        // The callback finds the player through PLAYER, set by the caller right after this returns
        if let Ok(mut slot) = PLAYER.lock() {
            *slot = Some(player.clone());
        }
        let _ = APP.set(app);
        (player.api.render_set_update_callback)(render, Some(on_render_update), std::ptr::null_mut());
        render_frame(&player, true);
        Ok(player)
    }
}

/// The GL view follows the window by itself; this redraws it after a resize even when paused.
fn spawn_resize_watcher(app: tauri::AppHandle, player: Arc<Player>) {
    std::thread::spawn(move || {
        while player.alive.load(Ordering::SeqCst) {
            std::thread::sleep(std::time::Duration::from_millis(150));
            let p = player.clone();
            let _ = app.run_on_main_thread(move || {
                // SAFETY: main thread
                let size = unsafe {
                    let bounds: Rect = msg_send![p.view, bounds];
                    let backing: Rect = msg_send![p.view, convertRectToBacking: bounds];
                    (backing.size.w as i32, backing.size.h as i32)
                };
                let changed = p.last_size.lock().map(|l| *l != size).unwrap_or(false);
                if changed {
                    render_frame(&p, true);
                }
            });
        }
    });
}

pub fn command(name: &str, args: &[Value]) -> Result<Option<Value>, String> {
    let player = current().filter(|p| p.alive.load(Ordering::SeqCst)).ok_or("mpv process failed: not started")?;
    match name {
        "get_property" => {
            let prop = args.first().map(to_arg).unwrap_or_default();
            player.get_property(&prop).map(Some).map_err(|e| format!("mpv command failed: {e}"))
        }
        "set_property" => {
            let (prop, value) = (args.first().map(to_arg).unwrap_or_default(), args.get(1).map(to_arg).unwrap_or_default());
            player.set_property(&prop, &value).map(|_| None).map_err(|e| format!("mpv command failed: {e}"))
        }
        _ => {
            let mut full = vec![name.to_string()];
            full.extend(args.iter().map(to_arg));
            player.command(&full).map_err(|e| format!("mpv command failed: {e}"))?;
            if name == "stop" || name == "loadfile" {
                repaint_soon(player);
            }
            Ok(None)
        }
    }
}

/// After `stop` / `loadfile`, mpv has no picture to show but the view keeps the last drawn frame
/// (nothing asks for a redraw). Force a draw now and once more shortly after, once mpv has
/// released the old video, so the viewer sees black instead of the previous title.
fn repaint_soon(player: Arc<Player>) {
    let Some(app) = APP.get() else { return };
    for delay_ms in [0u64, 120, 400] {
        let (app, p) = (app.clone(), player.clone());
        std::thread::spawn(move || {
            if delay_ms > 0 {
                std::thread::sleep(std::time::Duration::from_millis(delay_ms));
            }
            let q = p.clone();
            let _ = app.run_on_main_thread(move || render_frame(&q, true));
        });
    }
}

pub fn set_margins(left: Option<f64>, right: Option<f64>, top: Option<f64>, bottom: Option<f64>) -> Result<(), String> {
    let player = current().filter(|p| p.alive.load(Ordering::SeqCst)).ok_or("mpv process failed: not started")?;
    for (name, value) in [
        ("video-margin-ratio-left", left),
        ("video-margin-ratio-right", right),
        ("video-margin-ratio-top", top),
        ("video-margin-ratio-bottom", bottom),
    ] {
        if let Some(v) = value {
            player.set_property(name, &v.to_string())?;
        }
    }
    Ok(())
}

pub fn alive() -> bool {
    current().is_some_and(|p| p.alive.load(Ordering::SeqCst))
}
