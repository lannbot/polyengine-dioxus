//! Component gallery for **DioxusLabs' official `dioxus-primitives`** (the
//! unstyled primitive library behind
//! <https://github.com/DioxusLabs/dioxus-components>), running as a
//! polyengine-dioxus component instead of the dioxus-web renderer the
//! library's own preview site assumes.
//!
//! Upstream is pinned to rev `bf007c15d0cf4d04d3181cc46cf12325aa773955`
//! (dual MIT / Apache-2.0). The styling is that same rev's own preview CSS,
//! assembled into `harness/primitives.css`; the class names used below are
//! the literal ones the preview's `#[css_module(...)]` macro would generate
//! (`Styles::dx_switch` -> `dx-switch`). We have no such build-time macro, so
//! the strings are written out by hand and must agree with the vendored
//! stylesheet.
//!
//! # Compatibility matrix
//!
//! This renderer has no JS boundary: `document::eval` resolves to dioxus's
//! `NoOpDocument`, which answers every eval with `EvalError::Unsupported`
//! (dioxus-document-0.7.10 src/document.rs:121-145). That is a *graceful*
//! failure — nothing traps — so eval-dependent primitives still render and
//! still work for everything driven from Rust; they lose only the parts
//! implemented in JavaScript. They are included here with the loss named.
//!
//! ## Included and fully functional
//!
//! switch, slider, progress, tabs, radio_group, toggle, toggle_group,
//! toolbar, separator, label, aspect_ratio, scroll_area, calendar,
//! date_picker, avatar. (calendar and date_picker are only possible because the
//! guest now builds for `wasm32-wasip2`, which imports
//! `wasi:clocks/wall-clock`: `time`'s "now" works, falling back to UTC when
//! no local offset is available — primitives/src/lib.rs:333-337.)
//!
//! ## Included but degraded (`document::eval`), with what specifically breaks
//!
//! - **accordion, collapsible, tooltip, hover_card, dropdown_menu, menubar** —
//!   `use_animated_open` (primitives/src/lib.rs:244-280). Opening is
//!   synchronous and works. *Closing* spawns an eval that waits for CSS
//!   animations before unmounting; that eval errors immediately, so closed
//!   content stays in the DOM carrying `data-open="false"` /
//!   `data-state="closed"` instead of being removed. Upstream CSS collapses
//!   it on those attributes (e.g. `.dx-accordion-content[data-open="false"]`
//!   animates `grid-template-rows` to `0fr` with `forwards`), so the visible
//!   result is right — the element is merely still in the tree. Assert on the
//!   state attribute, not on element absence.
//! - **dialog, alert_dialog** — open/close via the Rust-side `open` signal
//!   works, as do the buttons inside. Lost: the focus trap (dialog.rs:239 and
//!   alert_dialog.rs:189 install one via `window.createFocusTrap`),
//!   escape-to-close (`use_global_escape_listener`), and for dialog also
//!   outside-click dismissal (`use_outside_dismiss`). Close them with their
//!   own button.
//! - **popover** — same open/close story. Lost: outside-click dismissal
//!   (`use_outside_dismiss`), escape-to-close, and JS-assisted collision
//!   repositioning, so the content sits where CSS puts it regardless of the
//!   viewport edge.
//! - **checkbox** — toggling, `data-state` and the indicator all work from
//!   Rust; that is the whole visible behaviour. The eval (checkbox.rs:252)
//!   only pushes the state onto the hidden real `<input>`'s `checked` /
//!   `indeterminate` DOM *properties*, which cannot be set by attribute — so
//!   the control is correct but the hidden input it would submit in a form is
//!   not. This gallery has no form.
//! - **drag_and_drop_list** — the list, its keyboard-reorder affordances and
//!   the live region all render, and keyboard reordering is the working path.
//!   Mouse dragging is not: `ondragstart` installs the document-level
//!   `dragover`/`drop` listeners that decide the drop target through an eval
//!   (drag_and_drop_list.rs:673), so a drag starts and then has nowhere to
//!   land.
//!
//! avatar deserves a note: it *does* work here. Its eval (avatar.rs:298) is
//! only a reconciliation path for cached or instant image loads that complete
//! before Dioxus delivers the synthetic load event; this renderer delivers
//! that event, so the state machine reaches `data-state="loaded"` on its own
//! and the fallback is correctly dropped. Verified in the browser.
//!
//! ## No longer the abort category: timers
//!
//! **select, toast, context_menu** pull `dioxus-sdk-time`, which waited by
//! calling `setTimeout` through wasm-bindgen. On `wasm32-wasip2` that
//! compiles to an off-target stub that panics ("function not implemented on
//! non-wasm32 targets") when called, aborting the whole component instance —
//! the app dies, it does not degrade. That was the one exclusion that was a
//! crash rather than a matter of taste.
//!
//! The workspace now patches `dioxus-sdk-time` to a fork whose `wasip3`
//! feature waits on `wasi:clocks/monotonic-clock` instead (root
//! `Cargo.toml`), an interface this host provides. `#progress-delayed` in the
//! Progress section is the witness: it sleeps 300ms through
//! `dioxus_sdk_time::sleep` and then moves `#progress-value`, so the e2e run
//! fails if the wait ever stops completing.
//!
//! What that changes per component:
//!
//! - **select** — the timer was its only blocker (a typeahead-buffer clear,
//!   select/context.rs:69). Adding it is now a matter of vendoring its
//!   preview stylesheet and writing the composition, not a platform gap.
//! - **toast, context_menu** — still out, but now for the ordinary reason:
//!   `document::eval`, same as the degraded group above.
//!
//! ## Excluded: missing machinery, no crash involved

//!
//! - **navbar** — `NavbarItem` requires a `to:` navigation target, i.e. a
//!   `dioxus-router` `Route` plus a history backend. Neither exists here.
//! - **listbox** — not public API. `primitives/src/lib.rs:33` declares it
//!   `mod listbox;` (private) and every item in it is `pub(crate)`: it is the
//!   shared machinery behind `select`/`combobox`, not a component a consumer
//!   can compose. There is also no preview directory and so no stylesheet.
//! - **pointer** — likewise private (`mod pointer;`), and a utility rather
//!   than UI: a global signal tracking pointer positions via document-level
//!   eval listeners. There is nothing to show, so it gets no section.
//! - **virtual_list** — attempted, then dropped: it does not degrade, it
//!   renders *nothing*. The visible window is derived from
//!   `state.viewport_size`, which starts at 0 and is only ever set by the
//!   eval scroll bridge (virtual_list.rs:176). With that bridge dead the item
//!   count stays zero, so the section is an empty 80,000px scroll canvas —
//!   visibly broken rather than merely limited.
//!
//! # Structural ids referenced by the e2e harness
//!
//! Root `#primitives-showcase`, plus `#demo-switch`, `#demo-slider`,
//! `#demo-tabs`, `#demo-accordion-p`, `#demo-progress`, the live readout
//! `#switch-state` (exactly `on` or `off`), and `#progress-delayed` /
//! `#progress-value` for the timer witness.

use dioxus::prelude::*;
use dioxus_primitives::{
    accordion, alert_dialog, aspect_ratio, avatar, calendar, checkbox, collapsible,
    drag_and_drop_list, dropdown_menu, hover_card, label, menubar, popover, progress, radio_group,
    scroll_area, separator, slider, switch, tabs, toggle, toggle_group, toolbar, tooltip,
    ContentAlign, ContentSide,
};
use dioxus_primitives::{date_picker, dialog};
use dioxus_sdk_time::sleep;
use std::time::Duration;
use time::{Date, Month, UtcDateTime};

/// A calendar month: header (prev/next + month & year selects) over the day
/// grid. The primitive `Calendar` takes its whole view as children — unlike
/// the preview site's wrapper it has no default body — so this composition is
/// mandatory rather than decorative. Mirrors
/// preview/src/components/calendar/component.rs (`CalendarMonthView` +
/// `CalendarGrid`), minus its lucide chevron icons, which would add an icon
/// crate for two glyphs.
#[component]
fn CalendarMonth() -> Element {
    rsx! {
        calendar::CalendarView { class: "dx-calendar-view", offset: 0u8,
            calendar::CalendarHeader {
                calendar::CalendarNavigation { class: "dx-calendar-navigation",
                    calendar::CalendarPreviousMonthButton { class: "dx-calendar-nav-prev", "\u{2039}" }
                    calendar::CalendarSelectMonth { class: "dx-calendar-month-select-container",
                        calendar::CalendarSelectMonthSelect { class: "dx-calendar-month-select" }
                        calendar::CalendarSelectMonthValue { class: "dx-calendar-month-select-value" }
                    }
                    calendar::CalendarSelectYear { class: "dx-calendar-year-select-container",
                        calendar::CalendarSelectYearSelect { class: "dx-calendar-year-select" }
                        calendar::CalendarSelectYearValue { class: "dx-calendar-year-select-value" }
                    }
                    calendar::CalendarNextMonthButton { class: "dx-calendar-nav-next", "\u{203a}" }
                }
            }
            CalendarGrid {}
        }
    }
}

/// The day grid. This has to be its own component rather than inlined into
/// [`CalendarMonth`]: `use_calendar_grid` reads the per-view context that
/// `CalendarView` provides, so calling it in the component that *renders*
/// `CalendarView` runs it before that context exists and panics — which on
/// this host surfaces as "guest trapped: unreachable" at mount, with no hint
/// of the cause. Upstream splits it the same way
/// (preview/src/components/calendar/component.rs, `CalendarGrid`).
#[component]
fn CalendarGrid() -> Element {
    let grid = calendar::use_calendar_grid();

    rsx! {
        calendar::CalendarGridRoot { class: "dx-calendar-grid",
            calendar::CalendarGridHead {
                calendar::CalendarGridHeaderRow { class: "dx-calendar-grid-header",
                    for weekday in grid.weekdays().iter().cloned() {
                        calendar::CalendarGridDayHeader {
                            key: "{weekday.weekday():?}",
                            class: "dx-calendar-grid-day-header",
                            weekday: weekday.weekday(),
                            {weekday.label().to_string()}
                        }
                    }
                }
            }
            calendar::CalendarGridBody { class: "dx-calendar-grid-body",
                for week in grid.weeks() {
                    calendar::CalendarGridWeek { class: "dx-calendar-grid-week",
                        for date in week.iter().copied() {
                            calendar::CalendarGridCell { key: "{date}",
                                calendar::CalendarDay { class: "dx-calendar-grid-cell", date }
                            }
                        }
                    }
                }
            }
        }
    }
}

/// The sortable items. Like [`CalendarGrid`], this must be its own component:
/// `use_drag_and_drop_list_items` reads the context `DragAndDropList`
/// provides, and rsx children are built in the *caller's* scope, so calling
/// the hook inline among `DragAndDropList`'s children runs it before that
/// context exists — a panic, which reaches the host as
/// "guest trapped: unreachable" at mount.
#[component]
fn DndItems() -> Element {
    rsx! {
        drag_and_drop_list::DragAndDropListItems {
            class: "dx-dnd-list-ul",
            aria_label: "Sortable list".to_string(),
            for item in drag_and_drop_list::use_drag_and_drop_list_items() {
                drag_and_drop_list::DragAndDropListItem {
                    key: "{item.key}",
                    class: "dx-dnd-list-item",
                    index: item.index,
                    item_key: item.key.clone(),
                    {item.children}
                }
            }
        }
    }
}

fn fixed_date(year: i32, month: Month, day: u8) -> Date {
    Date::from_calendar_date(year, month, day).expect("valid fixed date")
}

fn app() -> Element {
    let mut switch_on = use_signal(|| false);
    let mut slider_value = use_signal(|| 40.0f64);
    let mut progress_value = use_signal(|| 35.0f64);
    let mut radio_choice = use_signal(|| "option1".to_string());
    let mut bold = use_signal(|| false);
    let mut italic = use_signal(|| false);
    let mut menu_selection = use_signal(|| "none".to_string());
    let mut checkbox_state = use_signal(|| checkbox::CheckboxState::Unchecked);
    let mut dialog_open = use_signal(|| false);
    let mut alert_open = use_signal(|| false);
    let mut alert_confirmed = use_signal(|| false);
    let mut popover_open = use_signal(|| false);
    let mut calendar_selected = use_signal(|| None::<Date>);
    // Opens on the current month, which is the point: the wall clock is the
    // capability wasm32-wasip2 added. Upstream's own helper is
    // `pub(crate)` (primitives/src/lib.rs:327), so this inlines the arm of
    // it that actually runs here — `now_local()` asks for a local offset,
    // fails with `IndeterminateOffset` (no timezone database in this
    // component) and falls back to UTC. Reading `wasi:clocks/wall-clock`
    // directly says that plainly instead of dressing it up as local time. A
    // hardcoded month would render identically and demonstrate nothing; the
    // e2e assertions are month-agnostic so this stays honest.
    let mut calendar_view = use_signal(|| UtcDateTime::now().date());
    let mut picked_date = use_signal(|| None::<Date>);

    rsx! {
        div { id: "primitives-showcase", class: "showcase",

            h1 { "dioxus-primitives on polyengine" }

            section {
                h2 { "Switch" }
                // `Switch` takes `attributes`, so an `id:` would in fact land
                // on the rendered button — but the components example's
                // precedent is to hang harness ids off a wrapper so the id
                // survives any upstream change of which element gets the
                // attributes. Same here.
                div { id: "demo-switch", class: "row",
                    switch::Switch {
                        class: "dx-switch",
                        checked: switch_on(),
                        aria_label: "Switch demo",
                        on_checked_change: move |v| switch_on.set(v),
                        switch::SwitchThumb { class: "dx-switch-thumb" }
                    }
                    span { id: "switch-state", if switch_on() { "on" } else { "off" } }
                }
            }

            section {
                h2 { "Slider" }
                div { id: "demo-slider", class: "row",
                    slider::Slider {
                        class: "dx-slider",
                        value: slider_value(),
                        min: 0.0,
                        max: 100.0,
                        step: 1.0,
                        horizontal: true,
                        label: "Slider demo".to_string(),
                        on_value_change: move |v| slider_value.set(v),
                        slider::SliderTrack { class: "dx-slider-track",
                            slider::SliderRange { class: "dx-slider-range" }
                            slider::SliderThumb { class: "dx-slider-thumb" }
                        }
                    }
                    span { id: "slider-value", "{slider_value()}" }
                }
            }

            section {
                h2 { "Progress" }
                div { id: "demo-progress", class: "col",
                    progress::Progress {
                        class: "dx-progress",
                        aria_label: "Progress demo",
                        value: progress_value(),
                        max: 100.0,
                        progress::ProgressIndicator { class: "dx-progress-indicator" }
                    }
                    div { class: "row",
                        button {
                            id: "progress-inc",
                            onclick: move |_| progress_value.set((progress_value() + 10.0).min(100.0)),
                            "+10"
                        }
                        // The gallery's witness that `dioxus-sdk-time` waits
                        // complete here at all — see the module doc's timer
                        // section and the `[patch.crates-io]` entry in the
                        // root Cargo.toml. Deferred rather than instant, so
                        // an assertion can tell a real wait from a
                        // synchronous update.
                        button {
                            id: "progress-delayed",
                            onclick: move |_| async move {
                                sleep(Duration::from_millis(300)).await;
                                progress_value.set((progress_value() + 25.0).min(100.0));
                            },
                            "+25 after 300ms"
                        }
                        span { id: "progress-value", "{progress_value()}" }
                    }
                }
            }

            section {
                h2 { "Tabs" }
                // Upstream sets `data-variant` on the Tabs root; the vendored
                // CSS scopes the list/content chrome to it.
                div { id: "demo-tabs",
                    tabs::Tabs {
                        class: "dx-tabs",
                        "data-variant": "default",
                        default_value: "tab1".to_string(),
                        horizontal: true,
                        tabs::TabList { class: "dx-tabs-list",
                            tabs::TabTrigger {
                                class: "dx-tabs-trigger".to_string(),
                                value: "tab1".to_string(),
                                index: 0usize,
                                "Tab 1"
                            }
                            tabs::TabTrigger {
                                class: "dx-tabs-trigger".to_string(),
                                value: "tab2".to_string(),
                                index: 1usize,
                                "Tab 2"
                            }
                            tabs::TabTrigger {
                                class: "dx-tabs-trigger".to_string(),
                                value: "tab3".to_string(),
                                index: 2usize,
                                disabled: true,
                                "Tab 3 (disabled)"
                            }
                        }
                        tabs::TabContent {
                            class: "dx-tabs-content dx-tabs-content-themed".to_string(),
                            index: 0usize,
                            value: "tab1".to_string(),
                            "Tab 1 content"
                        }
                        tabs::TabContent {
                            class: "dx-tabs-content dx-tabs-content-themed".to_string(),
                            index: 1usize,
                            value: "tab2".to_string(),
                            "Tab 2 content"
                        }
                        tabs::TabContent {
                            class: "dx-tabs-content dx-tabs-content-themed".to_string(),
                            index: 2usize,
                            value: "tab3".to_string(),
                            "Tab 3 content"
                        }
                    }
                }
            }

            section {
                h2 { "Accordion" }
                div { id: "demo-accordion-p",
                    accordion::Accordion {
                        class: "dx-accordion",
                        width: "20rem",
                        allow_multiple_open: false,
                        collapsible: true,
                        for (i , (title , body)) in [
                            ("What is this?", "A gallery of DioxusLabs' dioxus-primitives."),
                            ("Does it use JS?", "No. The wasm component has no JS boundary."),
                        ]
                            .into_iter()
                            .enumerate()
                        {
                            accordion::AccordionItem {
                                key: "{i}",
                                class: "dx-accordion-item",
                                index: i,
                                accordion::AccordionTrigger { class: "dx-accordion-trigger", "{title}" }
                                accordion::AccordionContent {
                                    class: "dx-accordion-content",
                                    style: "--collapsible-content-width: 140px",
                                    p { "{body}" }
                                }
                            }
                        }
                    }
                }
            }

            section {
                h2 { "Collapsible" }
                collapsible::Collapsible {
                    collapsible::CollapsibleTrigger { class: "dx-collapsible-trigger",
                        b { "Recent activity" }
                    }
                    collapsible::CollapsibleContent { class: "dx-collapsible-content",
                        p { "Ported the primitives gallery to polyengine." }
                        p { "Vendored the preview site's stylesheet." }
                    }
                }
            }

            section {
                h2 { "Radio group" }
                radio_group::RadioGroup {
                    class: "dx-radio-group",
                    value: radio_choice(),
                    on_value_change: move |v| radio_choice.set(v),
                    radio_group::RadioItem {
                        class: "dx-radio-item".to_string(),
                        value: "option1".to_string(),
                        index: 0usize,
                        "Blue"
                    }
                    radio_group::RadioItem {
                        class: "dx-radio-item".to_string(),
                        value: "option2".to_string(),
                        index: 1usize,
                        "Red"
                    }
                    radio_group::RadioItem {
                        class: "dx-radio-item".to_string(),
                        value: "option3".to_string(),
                        index: 2usize,
                        disabled: true,
                        "Green (disabled)"
                    }
                }
                span { id: "radio-value", "{radio_choice()}" }
            }

            section {
                h2 { "Toggle" }
                toggle::Toggle {
                    class: "dx-toggle",
                    width: "2rem",
                    height: "2rem",
                    em { "B" }
                }
            }

            section {
                h2 { "Toggle group" }
                toggle_group::ToggleGroup {
                    class: "dx-toggle-group",
                    horizontal: true,
                    allow_multiple_pressed: true,
                    toggle_group::ToggleItem { class: "dx-toggle-item", index: 0usize,
                        b { "B" }
                    }
                    toggle_group::ToggleItem { class: "dx-toggle-item", index: 1usize,
                        i { "I" }
                    }
                    toggle_group::ToggleItem { class: "dx-toggle-item", index: 2usize,
                        u { "U" }
                    }
                }
            }

            section {
                h2 { "Toolbar" }
                toolbar::Toolbar { class: "dx-toolbar", aria_label: "Text formatting",
                    div { class: "dx-toolbar-group",
                        toolbar::ToolbarButton {
                            index: 0usize,
                            "data-state": if bold() { "on" } else { "off" },
                            on_click: move |_| bold.toggle(),
                            "Bold"
                        }
                        toolbar::ToolbarButton {
                            index: 1usize,
                            "data-state": if italic() { "on" } else { "off" },
                            on_click: move |_| italic.toggle(),
                            "Italic"
                        }
                    }
                    toolbar::ToolbarSeparator { class: "dx-toolbar-separator" }
                    div { class: "dx-toolbar-group",
                        p {
                            font_weight: if bold() { "bold" } else { "normal" },
                            font_style: if italic() { "italic" } else { "normal" },
                            "Sample text"
                        }
                    }
                }
            }

            section {
                h2 { "Separator" }
                div { class: "col",
                    "One thing"
                    separator::Separator {
                        class: "dx-separator",
                        style: "margin: 12px 0; width: 50%;",
                        horizontal: true,
                        decorative: true,
                    }
                    "Another thing"
                }
            }

            section {
                h2 { "Label" }
                div { class: "col",
                    label::Label { class: "dx-label", html_for: "labelled-input", "Name" }
                    input { id: "labelled-input", placeholder: "Enter your name" }
                }
            }

            section {
                h2 { "Scroll area" }
                scroll_area::ScrollArea {
                    width: "12em",
                    height: "8em",
                    border: "1px solid var(--primary-color-6)",
                    border_radius: "0.5em",
                    padding: "0 1em 1em 1em",
                    tabindex: "0",
                    div {
                        for i in 1..=20 {
                            p { key: "{i}", "Scrollable content item {i}" }
                        }
                    }
                }
            }

            section {
                h2 { "Aspect ratio" }
                div { class: "dx-aspect-ratio-container", width: "12rem",
                    aspect_ratio::AspectRatio { ratio: 4.0 / 3.0,
                        div {
                            width: "100%",
                            height: "100%",
                            background: "linear-gradient(to bottom right, var(--primary-color-5), var(--primary-color-3))",
                        }
                    }
                }
            }

            section {
                h2 { "Tooltip" }
                tooltip::Tooltip { class: "dx-tooltip",
                    tooltip::TooltipTrigger { class: "dx-tooltip-trigger", "Hover me" }
                    tooltip::TooltipContent {
                        class: "dx-tooltip-content",
                        side: ContentSide::Bottom,
                        "Tooltip content, rendered from Rust."
                    }
                }
            }

            section {
                h2 { "Hover card" }
                hover_card::HoverCard { class: "dx-hover-card",
                    hover_card::HoverCardTrigger { class: "dx-hover-card-trigger",
                        i { "Dioxus" }
                    }
                    hover_card::HoverCardContent {
                        class: "dx-hover-card-content",
                        side: ContentSide::Bottom,
                        div { padding: "1rem", "The Rust framework for fullstack apps." }
                    }
                }
            }

            section {
                h2 { "Dropdown menu" }
                dropdown_menu::DropdownMenu { class: "dx-dropdown-menu", default_open: false,
                    dropdown_menu::DropdownMenuTrigger { class: "dx-dropdown-menu-trigger", "Open menu" }
                    dropdown_menu::DropdownMenuContent { class: "dx-dropdown-menu-content",
                        for (i , op) in ["Edit", "Duplicate", "Delete"].into_iter().enumerate() {
                            dropdown_menu::DropdownMenuItem {
                                key: "{op}",
                                class: "dx-dropdown-menu-item",
                                value: op.to_string(),
                                index: i,
                                on_select: move |value: String| menu_selection.set(value),
                                "{op}"
                            }
                        }
                    }
                }
                span { id: "menu-selection", "{menu_selection()}" }
            }

            section {
                h2 { "Menubar" }
                menubar::Menubar { class: "dx-menubar",
                    menubar::MenubarMenu { class: "dx-menubar-menu", index: 0usize,
                        menubar::MenubarTrigger { class: "dx-menubar-trigger", "File" }
                        menubar::MenubarContent { class: "dx-menubar-content",
                            menubar::MenubarItem {
                                class: "dx-menubar-item",
                                index: 0usize,
                                value: "new".to_string(),
                                on_select: move |value: String| menu_selection.set(value),
                                "New"
                            }
                            menubar::MenubarItem {
                                class: "dx-menubar-item",
                                index: 1usize,
                                value: "open".to_string(),
                                disabled: true,
                                on_select: move |value: String| menu_selection.set(value),
                                "Open"
                            }
                        }
                    }
                    menubar::MenubarMenu { class: "dx-menubar-menu", index: 1usize,
                        menubar::MenubarTrigger { class: "dx-menubar-trigger", "Edit" }
                        menubar::MenubarContent { class: "dx-menubar-content",
                            menubar::MenubarItem {
                                class: "dx-menubar-item",
                                index: 0usize,
                                value: "copy".to_string(),
                                on_select: move |value: String| menu_selection.set(value),
                                "Copy"
                            }
                        }
                    }
                }
            }

            section {
                h2 { "Checkbox" }
                div { class: "row",
                    checkbox::Checkbox {
                        class: "dx-checkbox",
                        name: "tos-check",
                        aria_label: "Checkbox demo",
                        checked: checkbox_state(),
                        on_checked_change: move |s| checkbox_state.set(s),
                        checkbox::CheckboxIndicator { class: "dx-checkbox-indicator", "✔" }
                    }
                    span { id: "checkbox-p-state", "{checkbox_state():?}" }
                }
            }

            section {
                h2 { "Avatar" }
                // The image is a data: URI so this gallery makes no network
                // request. Note the fallback stays visible: see the header —
                // avatar's load/error detection is the eval-driven part.
                avatar::Avatar { class: "dx-avatar dx-avatar-md dx-avatar-circle", aria_label: "Avatar demo",
                    avatar::AvatarImage {
                        class: "dx-avatar-image",
                        src: "data:image/svg+xml;utf8,<svg xmlns='http://www.w3.org/2000/svg' width='64' height='64'><rect width='64' height='64' fill='%232b7fff'/></svg>",
                        alt: "Avatar demo image",
                    }
                    avatar::AvatarFallback { class: "dx-avatar-fallback", "DX" }
                }
            }

            section {
                h2 { "Dialog" }
                button {
                    id: "demo-p-dialog-open",
                    r#type: "button",
                    onclick: move |_| dialog_open.set(true),
                    "Show dialog"
                }
                dialog::DialogRoot {
                    class: "dx-dialog-backdrop",
                    open: dialog_open(),
                    on_open_change: move |v| dialog_open.set(v),
                    dialog::DialogContent { class: "dx-dialog".to_string(),
                        button {
                            id: "demo-p-dialog-close",
                            class: "dx-dialog-close",
                            r#type: "button",
                            aria_label: "Close",
                            tabindex: if dialog_open() { "0" } else { "-1" },
                            onclick: move |_| dialog_open.set(false),
                            "×"
                        }
                        dialog::DialogTitle { class: "dx-dialog-title", "Item information" }
                        dialog::DialogDescription { class: "dx-dialog-description",
                            "Here is some additional information about the item."
                        }
                    }
                }
            }

            section {
                h2 { "Alert dialog" }
                button {
                    id: "demo-p-alert-open",
                    r#type: "button",
                    onclick: move |_| alert_open.set(true),
                    "Show alert dialog"
                }
                alert_dialog::AlertDialogRoot {
                    class: "dx-alert-dialog-backdrop",
                    open: alert_open(),
                    on_open_change: move |v| alert_open.set(v),
                    alert_dialog::AlertDialogContent { class: "dx-alert-dialog".to_string(),
                        alert_dialog::AlertDialogTitle { class: "dx-alert-dialog-title", "Delete item" }
                        alert_dialog::AlertDialogDescription { class: "dx-alert-dialog-description",
                            "Are you sure? This action cannot be undone."
                        }
                        alert_dialog::AlertDialogActions { class: "dx-alert-dialog-actions",
                            alert_dialog::AlertDialogCancel {
                                class: "dx-alert-dialog-cancel",
                                on_click: move |_| alert_open.set(false),
                                "Cancel"
                            }
                            alert_dialog::AlertDialogAction {
                                class: "dx-alert-dialog-action",
                                on_click: move |_| {
                                    alert_confirmed.set(true);
                                    alert_open.set(false);
                                },
                                "Delete"
                            }
                        }
                    }
                }
                if alert_confirmed() {
                    p { id: "alert-confirmed", "Item deleted!" }
                }
            }

            section {
                h2 { "Popover" }
                popover::PopoverRoot {
                    class: "dx-popover",
                    open: popover_open(),
                    on_open_change: move |v| popover_open.set(v),
                    popover::PopoverTrigger { class: "dx-popover-trigger", id: "demo-p-popover-open",
                        "Show popover"
                    }
                    popover::PopoverContent {
                        class: "dx-popover-content".to_string(),
                        side: ContentSide::Bottom,
                        align: ContentAlign::Center,
                        h3 { margin: 0, "Delete item?" }
                        button {
                            r#type: "button",
                            onclick: move |_| popover_open.set(false),
                            "Cancel"
                        }
                    }
                }
            }

            section {
                h2 { "Calendar" }
                div { id: "demo-p-calendar",
                    calendar::Calendar {
                        class: "dx-calendar",
                        selected_date: calendar_selected(),
                        on_date_change: move |d| calendar_selected.set(d),
                        view_date: calendar_view(),
                        on_view_change: move |d: Date| calendar_view.set(d),
                        min_date: fixed_date(1995, Month::July, 21),
                        max_date: fixed_date(2035, Month::September, 11),
                        CalendarMonth {}
                    }
                }
            }

            section {
                h2 { "Date picker" }
                // Composition follows the primitive's own doc example
                // (primitives/src/date_picker.rs:96-127) rather than the
                // preview wrapper's segmented input, which is much larger and
                // adds nothing this renderer exercises differently.
                div { id: "demo-p-date-picker",
                    date_picker::DatePicker {
                        class: "dx-date-picker",
                        selected_date: picked_date(),
                        on_value_change: move |d| picked_date.set(d),
                        date_picker::DatePickerPopover {
                            date_picker::DatePickerInput { class: "dx-date-picker-group",
                                popover::PopoverTrigger { class: "dx-popover-trigger", "Select date" }
                                popover::PopoverContent {
                                    class: "dx-popover-content dx-date-picker-popover-content".to_string(),
                                    align: ContentAlign::Center,
                                    date_picker::DatePickerCalendar { class: "dx-calendar",
                                        CalendarMonth {}
                                    }
                                }
                            }
                        }
                    }
                    span { id: "picked-date",
                        match picked_date() {
                            Some(d) => d.to_string(),
                            None => "none".to_string(),
                        }
                    }
                }
            }

            section {
                h2 { "Drag and drop list" }
                drag_and_drop_list::DragAndDropList {
                    class: "dx-dnd-list",
                    aria_label: "Sortable list".to_string(),
                    items: ["Ship the roadmap", "Redesign onboarding", "Audit webhook logs"]
                        .iter()
                        .map(|label| {
                            rsx! {
                                div { key: "{label}", "{label}" }
                            }
                        })
                        .collect::<Vec<_>>(),
                    drag_and_drop_list::DragAndDropInstructions {}
                    DndItems {}
                    drag_and_drop_list::DragAndDropLiveRegion {}
                }
            }

            
        }
    }
}

polyengine_dioxus::launch!(app);
