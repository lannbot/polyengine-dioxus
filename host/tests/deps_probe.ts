// Import-map probe: the pinned polyengine embedder + translator resolve and
// typecheck from this repo. (Full instantiate coverage lives in the
// transport tests.)
import { instantiate } from "@deltic/runtime/embedder";
import { defaultTranslator } from "@deltic/translator";

export const _probe: [typeof instantiate, typeof defaultTranslator] = [
  instantiate,
  defaultTranslator,
];
