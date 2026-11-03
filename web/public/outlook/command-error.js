// adapters/primary/outlook/host.ts
var isRecord = (value) => typeof value === "object" && value !== null;
var readGlobalOffice = () => {
  const host = globalThis;
  if (!isRecord(host) || !("Office" in host)) {
    return void 0;
  }
  const office2 = host.Office;
  return isRecord(office2) ? office2 : void 0;
};
var isOfficeHost = (value) => "context" in value && "onReady" in value && "HostType" in value && "EventType" in value;
var readOfficeHost = () => {
  const office2 = readGlobalOffice();
  if (office2 === void 0 || !isOfficeHost(office2)) {
    return void 0;
  }
  return office2;
};

// adapters/primary/outlook/command-error.ts
var MAX_ERROR_MESSAGE_LENGTH = 500;
var ERROR_DISMISS_MESSAGE = "ready-error-dismiss";
var message = new URLSearchParams(location.hash.slice(1)).get("message");
var statusNode = document.querySelector("#status");
var closeButton = document.querySelector("#close");
if (message !== null && statusNode !== null) {
  statusNode.textContent = message.slice(0, MAX_ERROR_MESSAGE_LENGTH);
}
var office = readOfficeHost();
if (office !== void 0 && closeButton !== null) {
  office.onReady(() => {
    closeButton.addEventListener("click", () => {
      office.context.ui.messageParent(ERROR_DISMISS_MESSAGE, { targetOrigin: location.origin });
    });
  });
}
