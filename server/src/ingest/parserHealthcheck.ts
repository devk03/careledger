// Compatibility export for the first synthetic probe module path. The probe
// now uses a separate control socket so it cannot cancel a document decode.
export { checkParserLiveness } from "./parserHealthSocket.js";
