export const SERVER_ERROR_MESSAGE = "Hexclave error tracking demo: repeatable server error";

export function createServerError(): Error {
  const error = new Error(SERVER_ERROR_MESSAGE);
  error.name = "HexclaveDemoServerError";
  return error;
}
