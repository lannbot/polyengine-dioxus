// Barrel module for the polymorph:dioxus host runtime.

export { decodeBatch, FrameDecoder } from "./decoder.ts";
export type { OpSink, StrRef, TemplateNodeDesc } from "./decoder.ts";

export { DomApplier } from "./applier.ts";
export type { ListenerDelegate } from "./applier.ts";

export { EventDispatcher, serializePayload } from "./events.ts";
export type { DispatchSink, NativeEventLike } from "./events.ts";

export { mountApp } from "./host.ts";
export type { Mounted, MountOptions } from "./host.ts";
