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
//! The WIT `payload` variant has seven arms; dioxus-html has 21 data families.
//! A `convert_*` for an uncarried family (drag, touch, composition, clipboard,
//! media, animation, transition, image, resize, visible, selection, toggle,
//! cancel) has no data to work from, so it returns that family's
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
//! Likewise, a mismatched arm (e.g. `keyboard` payload arriving for a mouse
//! family, which the host should never send) degrades to the neutral value
//! instead of panicking: a malformed host must not take the app down.

use dioxus_html::geometry::{
    euclid::Point2D, ClientPoint, ElementPoint, PagePoint, Pixels, PixelsRect, PixelsSize,
    PixelsVector2D, ScreenPoint, WheelDelta,
};
use dioxus_html::input_data::{decode_mouse_button_set, MouseButton, MouseButtonSet};
use dioxus_html::point_interaction::{
    InteractionElementOffset, InteractionLocation, ModifiersInteraction, PointerInteraction,
};
use dioxus_html::{
    AnimationData, CancelData, ClipboardData, Code, CompositionData, DragData, FocusData, FormData,
    FormValue, HasAnimationData, HasCancelData, HasClipboardData, HasCompositionData, HasDragData,
    HasFileData, HasFocusData, HasFormData, HasImageData, HasKeyboardData, HasMediaData,
    HasMouseData, HasPointerData, HasResizeData, HasScrollData, HasSelectionData, HasToggleData,
    HasTouchData, HasTransitionData, HasVisibleData, HasWheelData, HtmlEventConverter, ImageData,
    Key, KeyboardData, MediaData, Modifiers, MountedData, MountedError, MountedResult, MouseData,
    PlatformEventData, PointerData, RenderedElementBacking, ResizeData, ScrollData, SelectionData,
    ScrollBehavior, ScrollLogicalPosition, ScrollToOptions, ToggleData, TouchData, TouchPoint,
    TransitionData, VisibleData, WheelData,
};
use std::future::Future;
use std::pin::Pin;

use crate::bindings::polymorph::dioxus::dom;
use crate::bindings::polymorph::dioxus::events as wit;

/// The platform event we box into dioxus's [`PlatformEventData`]: the raw WIT
/// payload for one dispatch, converted lazily by [`WitEventConverter`], plus
/// the ElementId the dispatch targeted (the handle `dom` operations take).
pub struct WitEventData {
    pub payload: wit::Payload,
    pub target: u32,
}

impl WitEventData {
    fn mouse(&self) -> wit::MouseData {
        match &self.payload {
            wit::Payload::Mouse(m) => *m,
            // Pointer and wheel payloads embed a full mouse snapshot; the
            // corresponding dioxus data types are supertypes of HasMouseData,
            // so reading through is exactly right.
            wit::Payload::Pointer(p) => p.mouse,
            wit::Payload::Wheel(w) => w.mouse,
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

struct Form(wit::FormData);

impl HasFileData for Form {
    fn files(&self) -> Vec<dioxus_html::FileData> {
        // File payloads are not carried across the boundary in this version
        // (they would need the file contents or a host-side handle resource).
        Vec::new()
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
        self.0.value.clone()
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
        self.0
            .values
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
    fn files(&self) -> Vec<dioxus_html::FileData> {
        Vec::new()
    }
}

/// Drag events are NOT currently mapped to the `mouse` family by the host —
/// host/src/events.ts dispatches all `drag*` names to `{ kind: "empty" }`,
/// and the WIT payload variant list has no `drag` arm at all in this
/// version. This struct exists for forward-compat: if/when the host gains
/// drag support and starts sending a mouse-shaped snapshot for drag events,
/// this reuses [`Mouse`] for the positional half and supplies empty
/// file/data-transfer halves. Until then it is unreachable from real events.
struct Drag(wit::MouseData);

impl InteractionLocation for Drag {
    fn client_coordinates(&self) -> ClientPoint {
        Mouse(self.0).client_coordinates()
    }
    fn screen_coordinates(&self) -> ScreenPoint {
        Mouse(self.0).screen_coordinates()
    }
    fn page_coordinates(&self) -> PagePoint {
        Mouse(self.0).page_coordinates()
    }
}

impl InteractionElementOffset for Drag {
    fn element_coordinates(&self) -> ElementPoint {
        Mouse(self.0).element_coordinates()
    }
}

impl ModifiersInteraction for Drag {
    fn modifiers(&self) -> Modifiers {
        modifiers(self.0.mods)
    }
}

impl PointerInteraction for Drag {
    fn trigger_button(&self) -> Option<MouseButton> {
        Mouse(self.0).trigger_button()
    }
    fn held_buttons(&self) -> MouseButtonSet {
        Mouse(self.0).held_buttons()
    }
}

impl HasMouseData for Drag {
    fn as_any(&self) -> &dyn std::any::Any {
        self
    }
}

impl HasFileData for Drag {
    fn files(&self) -> Vec<dioxus_html::FileData> {
        Vec::new()
    }
}

impl dioxus_html::HasDataTransferData for Drag {
    fn data_transfer(&self) -> dioxus_html::DataTransfer {
        dioxus_html::DataTransfer::new(EmptyDataTransfer)
    }
}

impl HasDragData for Drag {
    fn as_any(&self) -> &dyn std::any::Any {
        self
    }
}

/// A drag/clipboard data-transfer object with nothing in it: the wire does not
/// carry `DataTransfer` contents in this version.
struct EmptyDataTransfer;

impl dioxus_html::NativeDataTransfer for EmptyDataTransfer {
    fn get_data(&self, _format: &str) -> Option<String> {
        None
    }
    fn set_data(&self, _format: &str, _data: &str) -> Result<(), String> {
        Err("data transfer is not carried across the polymorph:dioxus boundary".into())
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
    fn files(&self) -> Vec<dioxus_html::FileData> {
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
        match payload(event).map(|p| &p.payload) {
            Some(wit::Payload::Form(f)) => FormData::new(Form(f.clone())),
            _ => FormData::new(Form(wit::FormData {
                value: String::new(),
                checked: None,
                values: Vec::new(),
            })),
        }
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
        DragData::new(Drag(payload(event).map(|p| p.mouse()).unwrap_or_else(empty_mouse)))
    }

    fn convert_focus_data(&self, _: &PlatformEventData) -> FocusData {
        FocusData::new(Empty)
    }

    fn convert_animation_data(&self, _: &PlatformEventData) -> AnimationData {
        AnimationData::new(Empty)
    }

    fn convert_cancel_data(&self, _: &PlatformEventData) -> CancelData {
        CancelData::new(Empty)
    }

    fn convert_clipboard_data(&self, _: &PlatformEventData) -> ClipboardData {
        ClipboardData::new(Empty)
    }

    fn convert_composition_data(&self, _: &PlatformEventData) -> CompositionData {
        CompositionData::new(Empty)
    }

    fn convert_image_data(&self, _: &PlatformEventData) -> ImageData {
        ImageData::new(Empty)
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

    fn convert_resize_data(&self, _: &PlatformEventData) -> ResizeData {
        ResizeData::new(Empty)
    }

    fn convert_selection_data(&self, _: &PlatformEventData) -> SelectionData {
        SelectionData::new(Empty)
    }

    fn convert_toggle_data(&self, _: &PlatformEventData) -> ToggleData {
        ToggleData::new(Empty)
    }

    fn convert_touch_data(&self, _: &PlatformEventData) -> TouchData {
        TouchData::new(Empty)
    }

    fn convert_transition_data(&self, _: &PlatformEventData) -> TransitionData {
        TransitionData::new(Empty)
    }

    fn convert_visible_data(&self, _: &PlatformEventData) -> VisibleData {
        VisibleData::new(Empty)
    }
}
