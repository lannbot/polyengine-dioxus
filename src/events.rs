//! dioxus-html event conversion over the WIT `events` payload types.
//!
//! `handle-event` hands us a `payload` variant chosen host-side by event name
//! (mirroring dioxus-html's name→data-family mapping, see `wit/world.wit`).
//! Dioxus, in turn, asks a renderer to convert an opaque `PlatformEventData`
//! into a family-specific `*Data` on demand, through the global
//! [`dioxus_html::HtmlEventConverter`]. This module bridges the two:
//!
//! - [`WitEventData`] is what we box into `PlatformEventData`: the payload
//!   plus the dispatch's target ElementId.
//! - [`WitEventConverter`] implements every `convert_*` method by downcasting
//!   to `WitEventData` and reading the matching payload arm.
//!
//! # What "families we don't carry" means
//!
//! The WIT `payload` variant has fifteen arms; dioxus-html has 21 data
//! families. A `convert_*` for an uncarried family (focus, cancel, clipboard,
//! media, selection and toggle — whose dioxus-html data types expose no
//! accessors at all) has no data to work from, so it returns that family's
//! empty/neutral value — the same thing a renderer returns when the platform
//! does not supply the information. Those events still *dispatch*: a handler
//! runs, it just sees zeroed data. This is a deliberate, visible gap rather
//! than a panic, and it is documented in `wit/world.wit`'s `events` interface.
//!
//! `mounted` is *not* in that list: its payload is `empty`, but the value its
//! handler wants is a live handle to the element, which we build from the
//! dispatch's `target` (see [`MountedElement`]). That handle implements
//! dioxus-html's `RenderedElementBacking` in full, over the `dom` WIT
//! interface — no `MountedData` query reports `NotSupported`.
//!
//! # Resources in a payload
//!
//! Two payload members are live host handles rather than snapshots: a form's
//! `list<own<file>>` and a drag's `own<data-transfer>`. Dioxus converts a
//! payload through a *shared* reference and may do so more than once per
//! dispatch, but an owned handle can only be moved out once, so
//! [`WitEventData::new`] lifts them out of the payload at construction into
//! `Rc`-shared wrappers ([`WitFile`], [`WitDataTransfer`]) — the payload it
//! stores afterwards has those members emptied. Both wrappers outlive the
//! dispatch, which is what `wit/world.wit` promises: a handler may read a
//! dropped file after its `await`.
//!
//! Likewise, a mismatched arm (e.g. `keyboard` payload arriving for a mouse
//! family, which the host should never send) degrades to the neutral value
//! instead of panicking: a malformed host must not take the app down.

use dioxus_html::bytes::Bytes;
use dioxus_html::geometry::{
    euclid::Point2D, ClientPoint, ElementPoint, PagePoint, Pixels, PixelsRect, PixelsSize,
    PixelsVector2D, ScreenPoint, WheelDelta,
};
use dioxus_html::input_data::{decode_mouse_button_set, MouseButton, MouseButtonSet};
use dioxus_html::point_interaction::{
    InteractionElementOffset, InteractionLocation, ModifiersInteraction, PointerInteraction,
};
use dioxus_html::{
    AnimationData, CancelData, ClipboardData, Code, CompositionData, DataTransfer, DragData,
    FileData, FocusData, FormData,
    FormValue, HasAnimationData, HasCancelData, HasClipboardData, HasCompositionData,
    HasDataTransferData, HasDragData,
    HasFileData, HasFocusData, HasFormData, HasImageData, HasKeyboardData, HasMediaData,
    HasMouseData, HasPointerData, HasResizeData, HasScrollData, HasSelectionData, HasToggleData,
    HasTouchData, HasTouchPointData, HasTransitionData, HasVisibleData, HasWheelData,
    HtmlEventConverter, ImageData, Key, KeyboardData, MediaData, Modifiers, MountedData,
    MountedError, MountedResult, MouseData, NativeDataTransfer, NativeFileData,
    PlatformEventData, PointerData, RenderedElementBacking, ResizeData, ResizeResult, ScrollData,
    SelectionData, ScrollBehavior, ScrollLogicalPosition, ScrollToOptions, ToggleData, TouchData,
    TouchPoint, TransitionData, VisibleData, VisibleError, VisibleResult, WheelData,
};
use dioxus_core::CapturedError;
use futures_util::Stream;
use std::future::Future;
use std::path::PathBuf;
use std::pin::Pin;
use std::rc::Rc;
use std::task::{Context, Poll};
use std::time::{Duration, SystemTime};

use crate::bindings::polymorph::dioxus::dom;
use crate::bindings::polymorph::dioxus::events as wit;

/// The platform event we box into dioxus's [`PlatformEventData`]: the raw WIT
/// payload for one dispatch, converted lazily by [`WitEventConverter`], plus
/// the ElementId the dispatch targeted (the handle `dom` operations take).
pub struct WitEventData {
    pub payload: wit::Payload,
    pub target: u32,
    /// A form payload's files, wrapped once (see the module doc). Empty for
    /// every other family — a drag's files come from its `data-transfer`,
    /// which hands out fresh handles on each call.
    files: Vec<FileData>,
    /// A drag payload's live `DataTransfer`, if the event had one.
    transfer: Option<Rc<wit::DataTransfer>>,
}

impl WitEventData {
    /// Lifts the payload's owned resource handles out into `Rc`-shared
    /// wrappers; see the module doc for why this cannot wait until conversion.
    pub fn new(mut payload: wit::Payload, target: u32) -> Self {
        let mut files = Vec::new();
        let mut transfer = None;
        match &mut payload {
            wit::Payload::Form(f) => {
                files = std::mem::take(&mut f.files).into_iter().map(file_data).collect();
            }
            wit::Payload::Drag(d) => transfer = d.transfer.take().map(Rc::new),
            _ => {}
        }
        Self { payload, target, files, transfer }
    }

    fn mouse(&self) -> wit::MouseData {
        match &self.payload {
            wit::Payload::Mouse(m) => *m,
            // Pointer and wheel payloads embed a full mouse snapshot; the
            // corresponding dioxus data types are supertypes of HasMouseData,
            // so reading through is exactly right.
            wit::Payload::Pointer(p) => p.mouse,
            wit::Payload::Wheel(w) => w.mouse,
            wit::Payload::Drag(d) => d.mouse,
            _ => empty_mouse(),
        }
    }
}

/// Neutral mouse snapshot: origin coordinates, no buttons held, no modifiers,
/// `button = -1` ("not applicable", per `wit/world.wit`).
fn empty_mouse() -> wit::MouseData {
    wit::MouseData {
        client_x: 0.0,
        client_y: 0.0,
        page_x: 0.0,
        page_y: 0.0,
        screen_x: 0.0,
        screen_y: 0.0,
        offset_x: 0.0,
        offset_y: 0.0,
        button: -1,
        buttons: 0,
        mods: wit::Modifiers::empty(),
    }
}

fn modifiers(mods: wit::Modifiers) -> Modifiers {
    let mut out = Modifiers::empty();
    out.set(Modifiers::ALT, mods.contains(wit::Modifiers::ALT));
    out.set(Modifiers::CONTROL, mods.contains(wit::Modifiers::CTRL));
    out.set(Modifiers::META, mods.contains(wit::Modifiers::META));
    out.set(Modifiers::SHIFT, mods.contains(wit::Modifiers::SHIFT));
    out
}

/// A mouse snapshot wearing the five dioxus pointer-interaction traits.
///
/// The four coordinate spaces are distinct types in dioxus (`euclid` phantom
/// units), so the mapping has to be explicit: client/page/screen come straight
/// from the DOM event; dioxus's "element" space is the DOM's `offsetX/offsetY`
/// (see dioxus-html `point_interaction.rs`, whose serialized form does the
/// same).
struct Mouse(wit::MouseData);

impl InteractionLocation for Mouse {
    fn client_coordinates(&self) -> ClientPoint {
        ClientPoint::new(self.0.client_x, self.0.client_y)
    }
    fn screen_coordinates(&self) -> ScreenPoint {
        ScreenPoint::new(self.0.screen_x, self.0.screen_y)
    }
    fn page_coordinates(&self) -> PagePoint {
        PagePoint::new(self.0.page_x, self.0.page_y)
    }
}

impl InteractionElementOffset for Mouse {
    fn element_coordinates(&self) -> ElementPoint {
        ElementPoint::new(self.0.offset_x, self.0.offset_y)
    }
}

impl ModifiersInteraction for Mouse {
    fn modifiers(&self) -> Modifiers {
        modifiers(self.0.mods)
    }
}

impl PointerInteraction for Mouse {
    fn trigger_button(&self) -> Option<MouseButton> {
        // `MouseEvent.button` is -1 when no button change triggered the event
        // (mousemove, mouseenter, ...). dioxus models that as `None` rather
        // than `MouseButton::Unknown`.
        (self.0.button >= 0).then(|| MouseButton::from_web_code(self.0.button))
    }
    fn held_buttons(&self) -> MouseButtonSet {
        decode_mouse_button_set(self.0.buttons)
    }
}

impl HasMouseData for Mouse {
    fn as_any(&self) -> &dyn std::any::Any {
        self
    }
}

/// Pointer events extend the mouse snapshot with stylus/touch geometry.
struct Pointer(wit::PointerData);

impl InteractionLocation for Pointer {
    fn client_coordinates(&self) -> ClientPoint {
        Mouse(self.0.mouse).client_coordinates()
    }
    fn screen_coordinates(&self) -> ScreenPoint {
        Mouse(self.0.mouse).screen_coordinates()
    }
    fn page_coordinates(&self) -> PagePoint {
        Mouse(self.0.mouse).page_coordinates()
    }
}

impl InteractionElementOffset for Pointer {
    fn element_coordinates(&self) -> ElementPoint {
        Mouse(self.0.mouse).element_coordinates()
    }
}

impl ModifiersInteraction for Pointer {
    fn modifiers(&self) -> Modifiers {
        modifiers(self.0.mouse.mods)
    }
}

impl PointerInteraction for Pointer {
    fn trigger_button(&self) -> Option<MouseButton> {
        Mouse(self.0.mouse).trigger_button()
    }
    fn held_buttons(&self) -> MouseButtonSet {
        Mouse(self.0.mouse).held_buttons()
    }
}

impl HasPointerData for Pointer {
    fn pointer_id(&self) -> i32 {
        self.0.pointer_id
    }
    fn width(&self) -> f64 {
        self.0.width
    }
    fn height(&self) -> f64 {
        self.0.height
    }
    // The DOM reports pressure/tilt/twist as doubles; dioxus narrows pressure
    // to f32 and tilt/twist to i32. Truncation matches dioxus-web.
    fn pressure(&self) -> f32 {
        self.0.pressure as f32
    }
    fn tangential_pressure(&self) -> f32 {
        self.0.tangential_pressure as f32
    }
    fn tilt_x(&self) -> i32 {
        self.0.tilt_x as i32
    }
    fn tilt_y(&self) -> i32 {
        self.0.tilt_y as i32
    }
    fn twist(&self) -> i32 {
        self.0.twist as i32
    }
    fn pointer_type(&self) -> String {
        self.0.pointer_type.clone()
    }
    fn is_primary(&self) -> bool {
        self.0.is_primary
    }
    fn as_any(&self) -> &dyn std::any::Any {
        self
    }
}

/// Wheel events are mouse events plus a delta in one of three unit spaces.
struct Wheel(wit::WheelData);

impl InteractionLocation for Wheel {
    fn client_coordinates(&self) -> ClientPoint {
        Mouse(self.0.mouse).client_coordinates()
    }
    fn screen_coordinates(&self) -> ScreenPoint {
        Mouse(self.0.mouse).screen_coordinates()
    }
    fn page_coordinates(&self) -> PagePoint {
        Mouse(self.0.mouse).page_coordinates()
    }
}

impl InteractionElementOffset for Wheel {
    fn element_coordinates(&self) -> ElementPoint {
        Mouse(self.0.mouse).element_coordinates()
    }
}

impl ModifiersInteraction for Wheel {
    fn modifiers(&self) -> Modifiers {
        modifiers(self.0.mouse.mods)
    }
}

impl PointerInteraction for Wheel {
    fn trigger_button(&self) -> Option<MouseButton> {
        Mouse(self.0.mouse).trigger_button()
    }
    fn held_buttons(&self) -> MouseButtonSet {
        Mouse(self.0.mouse).held_buttons()
    }
}

impl HasMouseData for Wheel {
    fn as_any(&self) -> &dyn std::any::Any {
        self
    }
}

impl HasWheelData for Wheel {
    fn delta(&self) -> WheelDelta {
        // `WheelDelta::from_web_attributes` panics on an out-of-range delta
        // mode; the DOM only defines 0/1/2, so clamp rather than trust the
        // host with a process abort.
        let mode = match self.0.delta_mode {
            1 => 1,
            2 => 2,
            _ => 0,
        };
        WheelDelta::from_web_attributes(mode, self.0.delta_x, self.0.delta_y, self.0.delta_z)
    }
    fn as_any(&self) -> &dyn std::any::Any {
        self
    }
}

struct Keyboard(wit::KeyboardData);

impl ModifiersInteraction for Keyboard {
    fn modifiers(&self) -> Modifiers {
        modifiers(self.0.mods)
    }
}

impl HasKeyboardData for Keyboard {
    fn key(&self) -> Key {
        // `Key::from_str` maps printable key strings to `Key::Character` and
        // named keys to their variants; anything else is `Unidentified`,
        // which is what a renderer should surface rather than failing.
        self.0.key.parse().unwrap_or(Key::Unidentified)
    }
    fn code(&self) -> Code {
        self.0.code.parse().unwrap_or(Code::Unidentified)
    }
    fn location(&self) -> dioxus_html::Location {
        dioxus_html::input_data::decode_key_location(self.0.location as usize)
    }
    fn is_auto_repeating(&self) -> bool {
        self.0.repeat
    }
    fn is_composing(&self) -> bool {
        self.0.is_composing
    }
    fn as_any(&self) -> &dyn std::any::Any {
        self
    }
}

/// How much of a file we ask the host for per stream read in
/// [`NativeFileData::byte_stream`]. The stream is chunked by whatever the host
/// writes; this only bounds the buffer we hand each read.
const FILE_CHUNK: usize = 64 * 1024;

/// One `own<file>` handle from a form payload or a `data-transfer`, behind the
/// `Rc` that lets the same handle back several `FileData` clones.
///
/// The `Rc` is what makes the `Send + Sync` on [`NativeFileData`] a lie we have
/// to tell: dioxus stores the backing in an `Arc<dyn NativeFileData>`, so the
/// bound is unconditional even on single-threaded platforms. dioxus-web asserts
/// it the same way for the same reason (dioxus-web-0.7.10 src/files.rs:17-18,
/// `unsafe impl Send/Sync for WebFileData` over a `web_sys::File`). It holds
/// here because a component instance is single-threaded: wasm32-wasip2 has no
/// threads we spawn, and a resource handle is only valid in the instance that
/// received it, so no `FileData` we hand out can be touched from elsewhere.
struct WitFile(Rc<wit::File>);

// SAFETY: see the type's doc — the component instance is single-threaded, so
// the `Rc` and the handle inside it are never reached from another thread.
unsafe impl Send for WitFile {}
unsafe impl Sync for WitFile {}

fn file_data(file: wit::File) -> FileData {
    FileData::new(WitFile(Rc::new(file)))
}

/// Same assertion as [`WitFile`], for the one place a *value* rather than a
/// backing has to cross the bound: `byte_stream`'s return type is `+ Send`
/// (dioxus-html-0.7.10 src/file_data.rs:73-82), but the stream holds the
/// non-`Send` `StreamReader`. dioxus-web wraps its stream in `send_wrapper`'s
/// `SendWrapper` for this (src/files.rs:120); `SendWrapper` additionally panics
/// on a cross-thread drop, which buys nothing on a target with one thread, so
/// we assert directly rather than take the dependency.
///
/// The inner stream is boxed (hence `Unpin`), so the delegation below needs no
/// pin projection.
struct SingleThreadedStream(Pin<Box<dyn Stream<Item = Result<Bytes, CapturedError>>>>);

// SAFETY: as [`WitFile`] — one thread per component instance.
unsafe impl Send for SingleThreadedStream {}

impl Stream for SingleThreadedStream {
    type Item = Result<Bytes, CapturedError>;
    fn poll_next(mut self: Pin<&mut Self>, cx: &mut Context<'_>) -> Poll<Option<Self::Item>> {
        self.0.as_mut().poll_next(cx)
    }
}

impl NativeFileData for WitFile {
    fn name(&self) -> String {
        self.0.name()
    }
    fn size(&self) -> u64 {
        self.0.size()
    }
    fn last_modified(&self) -> u64 {
        self.0.last_modified()
    }
    fn content_type(&self) -> Option<String> {
        self.0.content_type()
    }
    fn path(&self) -> PathBuf {
        // The wire carries no path: a browser `File` has none to give, and
        // dioxus-web falls back to the bare name for exactly that reason
        // (src/files.rs:143).
        PathBuf::from(self.0.name())
    }

    fn read_bytes(&self) -> Pin<Box<dyn Future<Output = Result<Bytes, CapturedError>> + 'static>> {
        let file = self.0.clone();
        // `read` starts a fresh read each call (wit/world.wit), and `collect`
        // drains the stream to its end (wit-bindgen-0.60.0
        // src/rt/async_support/stream_support.rs:551).
        Box::pin(async move { Ok(Bytes::from(file.read().collect().await)) })
    }

    fn read_string(
        &self,
    ) -> Pin<Box<dyn Future<Output = Result<String, CapturedError>> + 'static>> {
        let file = self.0.clone();
        Box::pin(async move { Ok(String::from_utf8(file.read().collect().await)?) })
    }

    fn byte_stream(
        &self,
    ) -> Pin<Box<dyn Stream<Item = Result<Bytes, CapturedError>> + 'static + Send>> {
        let file = self.0.clone();
        let reader = file.read();
        let inner: Pin<Box<dyn Stream<Item = Result<Bytes, CapturedError>>>> =
            // The state keeps the file handle alive alongside its reader, and
            // goes `None` once the host dropped the write end.
            Box::pin(futures_util::stream::unfold(Some((file, reader)), |state| async move {
                let (file, mut reader) = state?;
                loop {
                    let (status, buf) = reader.read(Vec::with_capacity(FILE_CHUNK)).await;
                    let more = matches!(status, wit_bindgen::rt::async_support::StreamResult::Complete(_));
                    if buf.is_empty() {
                        // A zero-length read on a still-open stream is not the
                        // end; yielding an empty chunk for it would be noise.
                        if more {
                            continue;
                        }
                        return None;
                    }
                    // A final read can deliver bytes *and* the drop together,
                    // so the last chunk still gets yielded (this is what
                    // `collect` relies on too, stream_support.rs:558-566).
                    return Some((Ok(Bytes::from(buf)), more.then_some((file, reader))));
                }
            }));
        Box::pin(SingleThreadedStream(inner))
    }

    fn inner(&self) -> &dyn std::any::Any {
        self
    }
}

/// A drag's live `data-transfer` handle. One-to-one with
/// [`NativeDataTransfer`]; `Send + Sync` as [`WitFile`].
struct WitDataTransfer(Rc<wit::DataTransfer>);

// SAFETY: as [`WitFile`] — one thread per component instance.
unsafe impl Send for WitDataTransfer {}
unsafe impl Sync for WitDataTransfer {}

impl NativeDataTransfer for WitDataTransfer {
    fn get_data(&self, format: &str) -> Option<String> {
        self.0.get_data(format)
    }
    fn set_data(&self, format: &str, data: &str) -> Result<(), String> {
        self.0.set_data(format, data)
    }
    fn clear_data(&self, format: Option<&str>) -> Result<(), String> {
        self.0.clear_data(format)
    }
    fn effect_allowed(&self) -> String {
        self.0.effect_allowed()
    }
    fn set_effect_allowed(&self, effect: &str) {
        self.0.set_effect_allowed(effect);
    }
    fn drop_effect(&self) -> String {
        self.0.drop_effect()
    }
    fn set_drop_effect(&self, effect: &str) {
        self.0.set_drop_effect(effect);
    }
    fn files(&self) -> Vec<FileData> {
        // `files` mints fresh owned handles per call (wit/world.wit), so this
        // needs no caching to stay correct — it mirrors dioxus-web, which
        // rebuilds from the live `FileList` each time (src/data_transfer.rs:52).
        self.0.files().into_iter().map(file_data).collect()
    }
}

/// A form event. Built field-by-field rather than by holding the payload arm:
/// `wit::FormData` owns file handles and so cannot be `Clone`.
struct Form {
    value: String,
    values: Vec<(String, Vec<String>)>,
    files: Vec<FileData>,
}

impl HasFileData for Form {
    fn files(&self) -> Vec<FileData> {
        // `FileData` is `Clone` (an `Arc` over the backing), so every call
        // hands out the same underlying handles.
        self.files.clone()
    }
}

impl HasFormData for Form {
    fn value(&self) -> String {
        // CONTRACT: `wit/world.wit` carries `value` and `checked` as separate
        // fields, but dioxus 0.7.10's `FormData::checked()` is *derived*:
        // `self.value().parse::<bool>().unwrap_or(false)` (dioxus-html
        // events/form.rs:39). So `evt.checked()` only works if `value` itself
        // is "true"/"false" for checkable controls — which is what
        // dioxus-web's own serializer does. We pass `value` through unchanged
        // (the conservative reading: never destroy the control's real value),
        // which means the host must encode checkable controls dioxus-style
        // for `checked()` to be meaningful. Flagged in the track report.
        self.value.clone()
    }
    fn valid(&self) -> bool {
        // Constraint validation state is not carried; `true` matches the
        // no-information default (a form with no reported problems).
        true
    }
    fn values(&self) -> Vec<(String, FormValue)> {
        // The wire carries name → list<string> (multi-valued controls keep
        // every value). dioxus's `FormValue` is one value per entry, so a
        // multi-select contributes several entries under the same name —
        // which is exactly how `FormData::values()` consumers read it.
        self.values
            .iter()
            .flat_map(|(name, vals)| {
                vals.iter().map(move |v| (name.clone(), FormValue::Text(v.clone())))
            })
            .collect()
    }
    fn as_any(&self) -> &dyn std::any::Any {
        self
    }
}

struct Scroll(wit::ScrollData);

impl HasScrollData for Scroll {
    fn scroll_top(&self) -> f64 {
        self.0.scroll_top
    }
    fn scroll_left(&self) -> f64 {
        self.0.scroll_left
    }
    fn scroll_width(&self) -> i32 {
        self.0.scroll_width as i32
    }
    fn scroll_height(&self) -> i32 {
        self.0.scroll_height as i32
    }
    fn client_width(&self) -> i32 {
        self.0.client_width as i32
    }
    fn client_height(&self) -> i32 {
        self.0.client_height as i32
    }
    fn as_any(&self) -> &dyn std::any::Any {
        self
    }
}

/// `load`/`error` on a resource element. The DOM splits these into two event
/// names; dioxus-html folds them into one family whose single accessor asks
/// which of the two it was.
struct Image(wit::ImageData);

impl HasImageData for Image {
    fn load_error(&self) -> bool {
        self.0.load_error
    }
    fn as_any(&self) -> &dyn std::any::Any {
        self
    }
}

/// An IME composition step; `data` is the text the input method contributed.
struct Composition(wit::CompositionData);

impl HasCompositionData for Composition {
    fn data(&self) -> String {
        self.0.data.clone()
    }
    fn as_any(&self) -> &dyn std::any::Any {
        self
    }
}

/// A CSS animation lifecycle event: which animation, on which pseudo-element,
/// how far in.
struct Animation(wit::AnimationData);

impl HasAnimationData for Animation {
    fn animation_name(&self) -> String {
        self.0.animation_name.clone()
    }
    fn pseudo_element(&self) -> String {
        self.0.pseudo_element.clone()
    }
    fn elapsed_time(&self) -> f32 {
        self.0.elapsed_time
    }
    fn as_any(&self) -> &dyn std::any::Any {
        self
    }
}

/// A CSS transition lifecycle event; one per animated property.
struct Transition(wit::TransitionData);

impl HasTransitionData for Transition {
    fn property_name(&self) -> String {
        self.0.property_name.clone()
    }
    fn pseudo_element(&self) -> String {
        self.0.pseudo_element.clone()
    }
    fn elapsed_time(&self) -> f32 {
        self.0.elapsed_time
    }
    fn as_any(&self) -> &dyn std::any::Any {
        self
    }
}

/// One finger. `HasTouchPointData` is `InteractionLocation` plus the
/// touch-specific geometry (dioxus-html-0.7.10 src/events/touch.rs:252-267);
/// note the radius is returned as a single `ScreenPoint` built from the DOM's
/// two radius axes.
struct TouchPointData(wit::TouchPoint);

impl InteractionLocation for TouchPointData {
    fn client_coordinates(&self) -> ClientPoint {
        ClientPoint::new(self.0.client_x, self.0.client_y)
    }
    fn screen_coordinates(&self) -> ScreenPoint {
        ScreenPoint::new(self.0.screen_x, self.0.screen_y)
    }
    fn page_coordinates(&self) -> PagePoint {
        PagePoint::new(self.0.page_x, self.0.page_y)
    }
}

impl HasTouchPointData for TouchPointData {
    fn identifier(&self) -> i32 {
        self.0.identifier
    }
    fn force(&self) -> f64 {
        self.0.force
    }
    fn radius(&self) -> ScreenPoint {
        ScreenPoint::new(self.0.radius_x, self.0.radius_y)
    }
    fn rotation(&self) -> f64 {
        self.0.rotation_angle
    }
    fn as_any(&self) -> &dyn std::any::Any {
        self
    }
}

/// A touch event: three views of the fingers involved, plus the keyboard
/// modifiers `HasTouchData`'s `ModifiersInteraction` supertrait asks for.
struct Touch(wit::TouchData);

fn touch_points(points: &[wit::TouchPoint]) -> Vec<TouchPoint> {
    points.iter().map(|p| TouchPoint::new(TouchPointData(*p))).collect()
}

impl ModifiersInteraction for Touch {
    fn modifiers(&self) -> Modifiers {
        modifiers(self.0.mods)
    }
}

impl HasTouchData for Touch {
    fn touches(&self) -> Vec<TouchPoint> {
        touch_points(&self.0.touches)
    }
    fn touches_changed(&self) -> Vec<TouchPoint> {
        touch_points(&self.0.changed_touches)
    }
    fn target_touches(&self) -> Vec<TouchPoint> {
        touch_points(&self.0.target_touches)
    }
    fn as_any(&self) -> &dyn std::any::Any {
        self
    }
}

/// A ResizeObserver entry. Both accessors are infallible here: the host only
/// dispatches this family from an observer callback, which always has both
/// boxes (`HasResizeData`, dioxus-html-0.7.10 src/events/resize.rs:115-127).
struct Resize(wit::ResizeData);

impl HasResizeData for Resize {
    fn get_border_box_size(&self) -> ResizeResult<PixelsSize> {
        Ok(PixelsSize::new(self.0.border_box.width, self.0.border_box.height))
    }
    fn get_content_box_size(&self) -> ResizeResult<PixelsSize> {
        Ok(PixelsSize::new(self.0.content_box.width, self.0.content_box.height))
    }
    fn as_any(&self) -> &dyn std::any::Any {
        self
    }
}

/// An IntersectionObserver entry (`HasVisibleData`, dioxus-html-0.7.10
/// src/events/visible.rs:228-261).
struct Visible(wit::VisibleData);

fn pixels_rect(r: dom::Rect) -> PixelsRect {
    PixelsRect::new(PixelsPoint::new(r.x, r.y), PixelsSize::new(r.width, r.height))
}

impl HasVisibleData for Visible {
    fn get_bounding_client_rect(&self) -> VisibleResult<PixelsRect> {
        Ok(pixels_rect(self.0.bounding_client_rect))
    }
    fn get_intersection_ratio(&self) -> VisibleResult<f64> {
        Ok(self.0.intersection_ratio)
    }
    fn get_intersection_rect(&self) -> VisibleResult<PixelsRect> {
        Ok(pixels_rect(self.0.intersection_rect))
    }
    fn is_intersecting(&self) -> VisibleResult<bool> {
        Ok(self.0.is_intersecting)
    }
    fn get_root_bounds(&self) -> VisibleResult<PixelsRect> {
        // CONTRACT: the wire says `option<rect>` because the DOM reports
        // `rootBounds` as null for an implicit cross-origin viewport root,
        // but dioxus's accessor has no way to say "absent" — it returns
        // `VisibleResult<PixelsRect>`. `NotSupported` is the only honest
        // mapping for `none`: the alternative, a zero rect, would be
        // indistinguishable from a real degenerate root box.
        self.0
            .root_bounds
            .map(pixels_rect)
            .ok_or(VisibleError::NotSupported)
    }
    fn get_time(&self) -> VisibleResult<SystemTime> {
        // `time_ms` is milliseconds since the Unix epoch by contract — the
        // host adds `performance.timeOrigin` to the entry's page-relative
        // timestamp — because that is the only reading under which this
        // accessor's own arithmetic is correct (visible.rs:203).
        Ok(SystemTime::UNIX_EPOCH + Duration::from_millis(self.0.time_ms))
    }
    fn as_any(&self) -> &dyn std::any::Any {
        self
    }
}

/// The neutral backing for every family the wire does not carry. It also
/// stands in for a payload arm that does not match the requested family.
struct Empty;


macro_rules! empty_as_any {
    ($($t:ty),* $(,)?) => {$(
        impl $t for Empty {
            fn as_any(&self) -> &dyn std::any::Any {
                self
            }
        }
    )*};
}

empty_as_any!(
    HasCancelData,
    HasClipboardData,
    HasFocusData,
    HasMediaData,
    HasSelectionData,
    HasToggleData,
);

impl HasAnimationData for Empty {
    fn animation_name(&self) -> String {
        String::new()
    }
    fn pseudo_element(&self) -> String {
        String::new()
    }
    fn elapsed_time(&self) -> f32 {
        0.0
    }
    fn as_any(&self) -> &dyn std::any::Any {
        self
    }
}

impl HasTransitionData for Empty {
    fn property_name(&self) -> String {
        String::new()
    }
    fn pseudo_element(&self) -> String {
        String::new()
    }
    fn elapsed_time(&self) -> f32 {
        0.0
    }
    fn as_any(&self) -> &dyn std::any::Any {
        self
    }
}

impl HasCompositionData for Empty {
    fn data(&self) -> String {
        String::new()
    }
    fn as_any(&self) -> &dyn std::any::Any {
        self
    }
}

impl HasImageData for Empty {
    fn load_error(&self) -> bool {
        false
    }
    fn as_any(&self) -> &dyn std::any::Any {
        self
    }
}

// Resize and Visible take the trait's own `NotSupported` defaults for every
// query; only `as_any` is mandatory.
impl HasResizeData for Empty {
    fn as_any(&self) -> &dyn std::any::Any {
        self
    }
}

impl HasVisibleData for Empty {
    fn as_any(&self) -> &dyn std::any::Any {
        self
    }
}

impl ModifiersInteraction for Empty {
    fn modifiers(&self) -> Modifiers {
        Modifiers::empty()
    }
}

impl HasTouchData for Empty {
    fn touches(&self) -> Vec<TouchPoint> {
        Vec::new()
    }
    fn touches_changed(&self) -> Vec<TouchPoint> {
        Vec::new()
    }
    fn target_touches(&self) -> Vec<TouchPoint> {
        Vec::new()
    }
    fn as_any(&self) -> &dyn std::any::Any {
        self
    }
}

impl HasFileData for Empty {
    fn files(&self) -> Vec<FileData> {
        Vec::new()
    }
}

/// A drag event: a mouse snapshot plus, when the event had one, the live
/// `data-transfer` handle it came with (`wit::DragData`). dioxus-html's
/// `DragData` is `HasMouseData + HasFileData + HasDataTransferData`
/// (dioxus-html-0.7.10 src/events/drag.rs), and all three halves are real
/// here: the positional one reuses [`Mouse`], the other two go through the
/// transfer.
struct Drag {
    mouse: wit::MouseData,
    transfer: Option<Rc<wit::DataTransfer>>,
}

impl InteractionLocation for Drag {
    fn client_coordinates(&self) -> ClientPoint {
        Mouse(self.mouse).client_coordinates()
    }
    fn screen_coordinates(&self) -> ScreenPoint {
        Mouse(self.mouse).screen_coordinates()
    }
    fn page_coordinates(&self) -> PagePoint {
        Mouse(self.mouse).page_coordinates()
    }
}

impl InteractionElementOffset for Drag {
    fn element_coordinates(&self) -> ElementPoint {
        Mouse(self.mouse).element_coordinates()
    }
}

impl ModifiersInteraction for Drag {
    fn modifiers(&self) -> Modifiers {
        modifiers(self.mouse.mods)
    }
}

impl PointerInteraction for Drag {
    fn trigger_button(&self) -> Option<MouseButton> {
        Mouse(self.mouse).trigger_button()
    }
    fn held_buttons(&self) -> MouseButtonSet {
        Mouse(self.mouse).held_buttons()
    }
}

impl HasMouseData for Drag {
    fn as_any(&self) -> &dyn std::any::Any {
        self
    }
}

impl HasFileData for Drag {
    fn files(&self) -> Vec<FileData> {
        // `DragData::files()` is `dataTransfer.files` — the same list, reached
        // the short way (dioxus-web does this too, src/data_transfer.rs:52).
        match &self.transfer {
            Some(t) => WitDataTransfer(t.clone()).files(),
            None => Vec::new(),
        }
    }
}

impl HasDataTransferData for Drag {
    fn data_transfer(&self) -> DataTransfer {
        match &self.transfer {
            Some(t) => DataTransfer::new(WitDataTransfer(t.clone())),
            None => DataTransfer::new(EmptyDataTransfer),
        }
    }
}

impl HasDragData for Drag {
    fn as_any(&self) -> &dyn std::any::Any {
        self
    }
}

/// The stand-in for `drag-data.transfer: none` — an event the host built
/// without a `dataTransfer` (a synthetic one), or a payload arm that did not
/// match the drag family at all. Empty rather than absent, because
/// `HasDataTransferData::data_transfer` has no way to say "there is none".
struct EmptyDataTransfer;

impl NativeDataTransfer for EmptyDataTransfer {
    fn get_data(&self, _format: &str) -> Option<String> {
        None
    }
    fn set_data(&self, _format: &str, _data: &str) -> Result<(), String> {
        Err("this drag event carried no data transfer".into())
    }
    fn clear_data(&self, _format: Option<&str>) -> Result<(), String> {
        Ok(())
    }
    fn effect_allowed(&self) -> String {
        // The DOM default for an unset `effectAllowed`.
        "uninitialized".into()
    }
    fn set_effect_allowed(&self, _effect: &str) {}
    fn drop_effect(&self) -> String {
        "none".into()
    }
    fn set_drop_effect(&self, _effect: &str) {}
    fn files(&self) -> Vec<FileData> {
        Vec::new()
    }
}

/// A point in CSS pixels. `dioxus_html::geometry` names `PixelsSize`,
/// `PixelsRect` and `PixelsVector2D` but has no point alias, and
/// `PixelsRect`'s origin is exactly this type (`Rect<f64, Pixels>` is
/// `Point2D<f64, Pixels>` + `Size2D<f64, Pixels>`), so we spell it once here.
type PixelsPoint = Point2D<f64, Pixels>;

/// The `RenderedElementBacking` behind a `MountedData`: an ElementId the host
/// can still resolve to a live node, for as long as that node lives.
///
/// The trait is covered in full — every method routes to the corresponding
/// operation of the `dom` WIT interface, which is the authority for what each
/// one means (`wit/world.wit`; the host implements them against the real DOM).
/// Nothing here reports `NotSupported`.
///
/// Every operation can still fail one way: the ElementId no longer names a
/// live node. That is expected rather than exceptional — ids are reused slab
/// indices, so a handle the app stashed outlives its element — and it reaches
/// the app as `MountedError::OperationFailed(StaleElement)`, never a trap. The
/// imports are synchronous, so each method returns an already-resolved future.
struct MountedElement {
    target: u32,
}

impl MountedElement {
    /// The one failure every operation shares.
    fn stale(&self) -> MountedError {
        MountedError::OperationFailed(Box::new(StaleElement(self.target)))
    }
}

/// `option`-returning query → dioxus result: `none` means no live node.
fn query<T, U>(
    el: &MountedElement,
    got: Option<T>,
    convert: impl FnOnce(T) -> U,
) -> Pin<Box<dyn Future<Output = MountedResult<U>>>>
where
    U: 'static,
{
    Box::pin(std::future::ready(got.map(convert).ok_or_else(|| el.stale())))
}

/// `bool`-returning command → dioxus result: `false` means no live node.
fn command(el: &MountedElement, ok: bool) -> Pin<Box<dyn Future<Output = MountedResult<()>>>> {
    Box::pin(std::future::ready(if ok { Ok(()) } else { Err(el.stale()) }))
}

impl RenderedElementBacking for MountedElement {
    fn as_any(&self) -> &dyn std::any::Any {
        self
    }

    fn get_scroll_offset(&self) -> Pin<Box<dyn Future<Output = MountedResult<PixelsVector2D>>>> {
        // `scrollLeft`/`scrollTop`: a displacement, hence a vector rather than
        // a point (dioxus-html geometry.rs:35).
        query(self, dom::get_scroll_offset(self.target), |p| {
            PixelsVector2D::new(p.x, p.y)
        })
    }

    fn get_scroll_size(&self) -> Pin<Box<dyn Future<Output = MountedResult<PixelsSize>>>> {
        query(self, dom::get_scroll_size(self.target), |s| {
            PixelsSize::new(s.width, s.height)
        })
    }

    fn get_client_rect(&self) -> Pin<Box<dyn Future<Output = MountedResult<PixelsRect>>>> {
        query(self, dom::get_client_rect(self.target), |r| {
            PixelsRect::new(PixelsPoint::new(r.x, r.y), PixelsSize::new(r.width, r.height))
        })
    }

    fn scroll_to(
        &self,
        options: ScrollToOptions,
    ) -> Pin<Box<dyn Future<Output = MountedResult<()>>>> {
        command(self, dom::scroll_to(self.target, wit_scroll_to_options(options)))
    }

    fn scroll(
        &self,
        coordinates: PixelsVector2D,
        behavior: ScrollBehavior,
    ) -> Pin<Box<dyn Future<Output = MountedResult<()>>>> {
        let offset = dom::Point { x: coordinates.x, y: coordinates.y };
        command(self, dom::scroll(self.target, offset, wit_scroll_behavior(behavior)))
    }

    fn set_focus(&self, focus: bool) -> Pin<Box<dyn Future<Output = MountedResult<()>>>> {
        command(self, dom::set_focus(self.target, focus))
    }
}

// The guest→host enum conversions below are exhaustive on the dioxus side by
// construction (no catch-all arm), so a variant added upstream is a compile
// error here rather than a silent mistranslation into some default.

fn wit_scroll_behavior(behavior: ScrollBehavior) -> dom::ScrollBehavior {
    match behavior {
        ScrollBehavior::Instant => dom::ScrollBehavior::Instant,
        ScrollBehavior::Smooth => dom::ScrollBehavior::Smooth,
    }
}

fn wit_scroll_alignment(position: ScrollLogicalPosition) -> dom::ScrollAlignment {
    match position {
        ScrollLogicalPosition::Start => dom::ScrollAlignment::Start,
        ScrollLogicalPosition::Center => dom::ScrollAlignment::Center,
        ScrollLogicalPosition::End => dom::ScrollAlignment::End,
        ScrollLogicalPosition::Nearest => dom::ScrollAlignment::Nearest,
    }
}

fn wit_scroll_to_options(options: ScrollToOptions) -> dom::ScrollToOptions {
    // `vertical`/`horizontal` are the DOM's `block`/`inline`; the WIT record
    // keeps dioxus's names so the mapping is field-for-field.
    dom::ScrollToOptions {
        behavior: wit_scroll_behavior(options.behavior),
        vertical: wit_scroll_alignment(options.vertical),
        horizontal: wit_scroll_alignment(options.horizontal),
    }
}

/// A `dom` operation reported no live node for this ElementId.
#[derive(Debug)]
struct StaleElement(u32);

impl std::fmt::Display for StaleElement {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        write!(f, "element id {} is no longer live", self.0)
    }
}

impl std::error::Error for StaleElement {}

/// Installs into dioxus-html's global converter slot (see
/// [`dioxus_html::set_event_converter`]); every `Event<XData>` a handler
/// receives is produced by one of these methods.
pub struct WitEventConverter;

fn payload(event: &PlatformEventData) -> Option<&WitEventData> {
    event.downcast::<WitEventData>()
}

impl HtmlEventConverter for WitEventConverter {
    fn convert_mouse_data(&self, event: &PlatformEventData) -> MouseData {
        MouseData::new(Mouse(payload(event).map(|p| p.mouse()).unwrap_or_else(empty_mouse)))
    }

    fn convert_pointer_data(&self, event: &PlatformEventData) -> PointerData {
        match payload(event).map(|p| &p.payload) {
            Some(wit::Payload::Pointer(p)) => PointerData::new(Pointer(p.clone())),
            // A mouse-shaped payload still yields usable coordinates; the
            // stylus fields fall back to their neutral values.
            other => {
                let mouse = match other {
                    Some(wit::Payload::Mouse(m)) => *m,
                    Some(wit::Payload::Wheel(w)) => w.mouse,
                    _ => empty_mouse(),
                };
                PointerData::new(Pointer(wit::PointerData {
                    mouse,
                    pointer_id: 0,
                    width: 0.0,
                    height: 0.0,
                    pressure: 0.0,
                    tangential_pressure: 0.0,
                    tilt_x: 0.0,
                    tilt_y: 0.0,
                    twist: 0.0,
                    pointer_type: String::new(),
                    is_primary: false,
                }))
            }
        }
    }

    fn convert_keyboard_data(&self, event: &PlatformEventData) -> KeyboardData {
        match payload(event).map(|p| &p.payload) {
            Some(wit::Payload::Keyboard(k)) => KeyboardData::new(Keyboard(k.clone())),
            _ => KeyboardData::new(Keyboard(wit::KeyboardData {
                key: String::new(),
                code: String::new(),
                location: 0,
                repeat: false,
                is_composing: false,
                mods: wit::Modifiers::empty(),
            })),
        }
    }

    fn convert_wheel_data(&self, event: &PlatformEventData) -> WheelData {
        match payload(event).map(|p| &p.payload) {
            Some(wit::Payload::Wheel(w)) => WheelData::new(Wheel(*w)),
            _ => WheelData::new(Wheel(wit::WheelData {
                mouse: empty_mouse(),
                delta_x: 0.0,
                delta_y: 0.0,
                delta_z: 0.0,
                delta_mode: 0,
            })),
        }
    }

    fn convert_form_data(&self, event: &PlatformEventData) -> FormData {
        let form = match payload(event) {
            Some(p) => match &p.payload {
                wit::Payload::Form(f) => Form {
                    value: f.value.clone(),
                    values: f.values.clone(),
                    // Lifted out of the payload at construction; see the
                    // module doc on resources.
                    files: p.files.clone(),
                },
                _ => Form { value: String::new(), values: Vec::new(), files: Vec::new() },
            },
            None => Form { value: String::new(), values: Vec::new(), files: Vec::new() },
        };
        FormData::new(form)
    }

    fn convert_scroll_data(&self, event: &PlatformEventData) -> ScrollData {
        match payload(event).map(|p| &p.payload) {
            Some(wit::Payload::Scroll(s)) => ScrollData::new(Scroll(*s)),
            _ => ScrollData::new(Scroll(wit::ScrollData {
                scroll_top: 0.0,
                scroll_left: 0.0,
                scroll_width: 0.0,
                scroll_height: 0.0,
                client_width: 0.0,
                client_height: 0.0,
            })),
        }
    }

    fn convert_drag_data(&self, event: &PlatformEventData) -> DragData {
        // Only the `drag` arm produces a drag: the host routes every
        // `drag*`/`drop` name to it now, so a `mouse` payload arriving here is
        // a host bug, and quietly half-converting it would hide that. It
        // degrades to the neutral value like every other family mismatch.
        let drag = match payload(event) {
            Some(p) => match &p.payload {
                wit::Payload::Drag(d) => Drag { mouse: d.mouse, transfer: p.transfer.clone() },
                _ => Drag { mouse: empty_mouse(), transfer: None },
            },
            None => Drag { mouse: empty_mouse(), transfer: None },
        };
        DragData::new(drag)
    }

    fn convert_focus_data(&self, _: &PlatformEventData) -> FocusData {
        FocusData::new(Empty)
    }

    fn convert_animation_data(&self, event: &PlatformEventData) -> AnimationData {
        match payload(event).map(|p| &p.payload) {
            Some(wit::Payload::Animation(a)) => AnimationData::new(Animation(a.clone())),
            _ => AnimationData::new(Empty),
        }
    }

    fn convert_cancel_data(&self, _: &PlatformEventData) -> CancelData {
        CancelData::new(Empty)
    }

    fn convert_clipboard_data(&self, _: &PlatformEventData) -> ClipboardData {
        ClipboardData::new(Empty)
    }

    fn convert_composition_data(&self, event: &PlatformEventData) -> CompositionData {
        match payload(event).map(|p| &p.payload) {
            Some(wit::Payload::Composition(c)) => CompositionData::new(Composition(c.clone())),
            _ => CompositionData::new(Empty),
        }
    }

    fn convert_image_data(&self, event: &PlatformEventData) -> ImageData {
        match payload(event).map(|p| &p.payload) {
            Some(wit::Payload::Image(i)) => ImageData::new(Image(*i)),
            _ => ImageData::new(Empty),
        }
    }

    fn convert_media_data(&self, _: &PlatformEventData) -> MediaData {
        MediaData::new(Empty)
    }

    fn convert_mounted_data(&self, event: &PlatformEventData) -> MountedData {
        match payload(event) {
            Some(p) => MountedData::new(MountedElement { target: p.target }),
            // Not our platform data: `()` is dioxus's own no-capability
            // backing, every query reporting `NotSupported`.
            None => MountedData::new(()),
        }
    }

    fn convert_resize_data(&self, event: &PlatformEventData) -> ResizeData {
        match payload(event).map(|p| &p.payload) {
            Some(wit::Payload::Resize(r)) => ResizeData::new(Resize(*r)),
            _ => ResizeData::new(Empty),
        }
    }

    fn convert_selection_data(&self, _: &PlatformEventData) -> SelectionData {
        SelectionData::new(Empty)
    }

    fn convert_toggle_data(&self, _: &PlatformEventData) -> ToggleData {
        ToggleData::new(Empty)
    }

    fn convert_touch_data(&self, event: &PlatformEventData) -> TouchData {
        match payload(event).map(|p| &p.payload) {
            Some(wit::Payload::Touch(t)) => TouchData::new(Touch(t.clone())),
            _ => TouchData::new(Empty),
        }
    }

    fn convert_transition_data(&self, event: &PlatformEventData) -> TransitionData {
        match payload(event).map(|p| &p.payload) {
            Some(wit::Payload::Transition(t)) => TransitionData::new(Transition(t.clone())),
            _ => TransitionData::new(Empty),
        }
    }

    fn convert_visible_data(&self, event: &PlatformEventData) -> VisibleData {
        match payload(event).map(|p| &p.payload) {
            Some(wit::Payload::Visible(v)) => VisibleData::new(Visible(*v)),
            _ => VisibleData::new(Empty),
        }
    }
}
