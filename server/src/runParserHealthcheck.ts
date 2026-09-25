import { checkParserLiveness } from "./ingest/parserHealthSocket.js";

const socketPath = process.env.ADENO_PARSER_HEALTH_SOCKET_PATH;
if (!socketPath || !await checkParserLiveness(socketPath)) process.exitCode = 1;
