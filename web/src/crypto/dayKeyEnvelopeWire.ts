/** Browser compatibility path; the exact wire codec is shared with the server. */
export { DAY_KEY_HEADER_BYTES, DAY_KEY_WIRE_BYTES, DayKeyEnvelopeWireError,
  assertDayKeyEnvelopeShape, encodeDayKeyHeader, encodeDayKeyEnvelope,
  decodeDayKeyEnvelope } from "@adeno/contracts";
