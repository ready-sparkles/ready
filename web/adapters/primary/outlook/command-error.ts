import { readOfficeHost } from "./host";

const MAX_ERROR_MESSAGE_LENGTH = 500;
const ERROR_DISMISS_MESSAGE = "ready-error-dismiss";

const message = new URLSearchParams(location.hash.slice(1)).get("message");
const statusNode = document.querySelector("#status");
const closeButton = document.querySelector("#close");
if (message !== null && statusNode !== null) {
  statusNode.textContent = message.slice(0, MAX_ERROR_MESSAGE_LENGTH);
}

const office = readOfficeHost();
if (office !== undefined && closeButton !== null) {
  office.onReady(() => {
    closeButton.addEventListener("click", () => {
      office.context.ui.messageParent(ERROR_DISMISS_MESSAGE, { targetOrigin: location.origin });
    });
  });
}
