/* exported onHomepage, onCreateReadyConference, handleRetryReadyConnection, debugIdentityAudience, debugVerify */
/** Apps Script discovers these declarations as public host callbacks. */
function onHomepage() {
	return ReadyAddon.onHomepage();
}

function onCreateReadyConference(e) {
	return ReadyAddon.onCreateReadyConference(e);
}

function handleRetryReadyConnection() {
	return ReadyAddon.handleRetryReadyConnection();
}

function debugIdentityAudience() {
	return ReadyAddon.debugIdentityAudience();
}

function debugVerify() {
	return ReadyAddon.debugVerify();
}
