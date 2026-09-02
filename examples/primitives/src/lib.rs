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
//! This renderer has no JS boundary (`wbg-sever` removes the wasm-bindgen
//! imports, so an executed wasm-bindgen call traps) and no wall clock. That
//! rules three groups of primitives out of this demo:
//!
//! 1. **`document::eval`-driven behavior** — dialog, alert_dialog, popover,
//!    context_menu, toast, checkbox, avatar, drag_and_drop_list, pointer,
//!    virtual_list. These reach JS directly or through
//!    `use_outside_dismiss` / `use_global_escape_listener` /
//!    `use_global_keydown_listener` (primitives/src/lib.rs). They would still
//!    *render*: dioxus's `NoOpDocument` answers every eval with
//!    `EvalError::Unsupported` (dioxus-document-0.7.10
//!    src/document.rs:121-145) rather than trapping. But their JS-driven
//!    behavior — dismiss-on-outside-click, escape handling, measurement —
//!    silently does nothing. Excluded because a demo of a control that looks
//!    right and doesn't work is worse than no demo.
//! 2. **wasm-bindgen timers** — select, toast, context_menu pull
//!    `dioxus-sdk-time` -> `gloo-timers`, whose calls are severed imports and
//!    would trap on execution.
//! 3. **No wall clock** — calendar, date_picker need
//!    `OffsetDateTime::now_local_date()`, which this host does not provide.
//!
//! Two further omissions specific to this build:
//!
//! - **navbar**: `NavbarItem` requires a `to:` navigation target, i.e. a
//!   `dioxus-router` `Route` enum. This example has no router; adding one to
//!   show a navbar is out of proportion.
//! - **listbox**: the upstream preview site has no `listbox` component
//!   directory at the pinned rev, so there is no stylesheet to vendor and no
//!   reference composition to follow.
//!
//! Everything shown below is the upstream primitive, driven by Rust-side
//! state and plain DOM events.
//!
//! ## The one degradation that *is* on display
//!
//! Accordion, collapsible content, tooltip, hover card, dropdown menu and
//! menubar content all mount through `use_animated_open`
//! (primitives/src/lib.rs:244-280). Opening is synchronous. *Closing* spawns
//! an eval that waits for CSS animations to finish before unmounting; under
//! `NoOpDocument` that eval errors immediately, so the closed content stays
//! in the DOM carrying `data-open="false"` / `data-state="closed"` instead of
//! being removed. Upstream's own CSS collapses/hides it on those attributes
//! (e.g. `.dx-accordion-content[data-open="false"]` animates
//! `grid-template-rows` to `0fr` with `forwards`), so the visible result is
//! correct — the element is merely still in the tree. Worth knowing when
//! writing assertions: check the state attribute, not element absence.
//!
//! # Structural ids referenced by the e2e harness
//!
//! Root `#primitives-showcase`, plus `#demo-switch`, `#demo-slider`,
//! `#demo-tabs`, `#demo-accordion-p`, `#demo-progress`, and the live readout
//! `#switch-state` (exactly `on` or `off`).

use dioxus::prelude::*;
use dioxus_primitives::{
    accordion, aspect_ratio, collapsible, dropdown_menu, hover_card, label, menubar, progress,
    radio_group, scroll_area, separator, slider, switch, tabs, toggle, toggle_group, toolbar,
    tooltip, ContentSide,
};

fn app() -> Element {
    let mut switch_on = use_signal(|| false);
    let mut slider_value = use_signal(|| 40.0f64);
    let mut progress_value = use_signal(|| 35.0f64);
    let mut radio_choice = use_signal(|| "option1".to_string());
    let mut bold = use_signal(|| false);
    let mut italic = use_signal(|| false);
    let mut menu_selection = use_signal(|| "none".to_string());

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
        }
    }
}

polyengine_dioxus::launch!(app);
