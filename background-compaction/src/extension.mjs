import { convertToLlm, serializeConversation } from "@earendil-works/pi-coding-agent";
import { registerBackgroundCompaction } from "./background-runtime.mjs";

export { registerBackgroundCompaction } from "./background-runtime.mjs";

export default function backgroundCompactionExtension(pi) {
  return registerBackgroundCompaction(pi, {
    serializeMessages: (messages) => serializeConversation(convertToLlm(messages)),
    // Pi's installed default reserveTokens is 16,384. Use the model currently selected in Pi.
    settings: { reserveTokens: 16_384 },
  });
}
