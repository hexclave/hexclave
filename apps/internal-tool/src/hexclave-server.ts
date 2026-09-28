import "server-only";

import { HexclaveServerApp } from "@hexclave/next";
import { getHexclaveClientApp } from "./hexclave";

let hexclaveServerApp: HexclaveServerApp<true, string> | undefined;

export function getHexclaveServerApp(): HexclaveServerApp<true, string> {
  if (hexclaveServerApp == null) {
    hexclaveServerApp = new HexclaveServerApp({
      inheritsFrom: getHexclaveClientApp(),
    });
  }
  return hexclaveServerApp;
}
