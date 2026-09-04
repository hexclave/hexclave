const form = document.querySelector("#wifi-form");
const statusElement = document.querySelector("#status");
const networkSelect = document.querySelector("#network");
const passwordRow = document.querySelector("#password-row");
const manualName = document.querySelector("#manual-name");
const manualSecurity = document.querySelector("#manual-security");
const ssidInput = document.querySelector("#ssid");
const passwordInput = document.querySelector("#password");
let csrfToken = null;
let networks = [];

async function loadStatus() {
  const response = await fetch("/api/status", { cache: "no-store" });
  if (!response.ok) throw new Error("Setup status is unavailable.");
  const status = await response.json();
  csrfToken = status.csrfToken;
  const ssid = document.querySelector("#setup-ssid");
  const password = document.querySelector("#setup-password");
  if (ssid != null) ssid.textContent = status.setupSsid ?? "Preparing…";
  if (password != null) password.textContent = status.setupPassword ?? "Preparing…";
}

function selectedNetwork() {
  const index = Number(networkSelect.value);
  return Number.isInteger(index) && networks[index] != null ? networks[index] : null;
}

function updateFields() {
  const network = selectedNetwork();
  const manual = network == null;
  manualName.hidden = !manual;
  manualSecurity.hidden = !manual;
  ssidInput.required = manual;
  const security = network?.security ?? document.querySelector("#security").value;
  passwordRow.hidden = security === "open";
  passwordInput.required = security !== "open";
}

async function loadNetworks() {
  const response = await fetch("/api/networks", { cache: "no-store" });
  if (!response.ok) throw new Error("Nearby networks are unavailable.");
  const result = await response.json();
  networks = Array.isArray(result.networks) ? result.networks : [];
  networkSelect.replaceChildren();
  for (const [index, network] of networks.entries()) {
    const option = document.createElement("option");
    option.value = String(index);
    option.disabled = network.security === "unsupported";
    option.textContent = `${network.ssid} · ${network.signal}${option.disabled ? " · unsupported" : ""}`;
    networkSelect.append(option);
  }
  const manualOption = document.createElement("option");
  manualOption.value = "manual";
  manualOption.textContent = "Enter another network…";
  networkSelect.append(manualOption);
  updateFields();
  statusElement.textContent = "Wi-Fi credentials stay only on this TV Box.";
}

networkSelect?.addEventListener("change", updateFields);
document.querySelector("#security")?.addEventListener("change", updateFields);
form?.addEventListener("submit", async (event) => {
  event.preventDefault();
  const button = form.querySelector("button");
  button.disabled = true;
  statusElement.textContent = "Connecting the TV Box…";
  const network = selectedNetwork();
  const hidden = document.querySelector("#hidden").checked;
  const ssid = network?.ssid ?? document.querySelector("#ssid").value;
  const security = network?.security ?? document.querySelector("#security").value;
  const password = security === "open" ? null : document.querySelector("#password").value;
  try {
    const response = await fetch("/api/wifi", {
      method: "POST",
      cache: "no-store",
      headers: { "Content-Type": "application/json", "X-Hexclave-CSRF": csrfToken },
      body: JSON.stringify({ ssid, security, password, hidden, timezone: Intl.DateTimeFormat().resolvedOptions().timeZone ?? "UTC" }),
    });
    if (!response.ok) throw new Error("The TV Box could not join that network.");
    statusElement.textContent = "Connected. TV Mode will open on the display shortly.";
  } catch {
    // The Zero 2 W has one radio, so a successful join drops the temporary
    // setup network before the HTTP response can always reach this device.
    statusElement.textContent = "The TV Box is switching networks. Check the TV display; reconnect to the setup network if it asks you to try again.";
    button.disabled = false;
  }
});

loadStatus()
  .then(() => form == null ? undefined : loadNetworks())
  .catch(() => {
    if (statusElement != null) statusElement.textContent = "Setup is temporarily unavailable. Please wait a moment and try again.";
  });
