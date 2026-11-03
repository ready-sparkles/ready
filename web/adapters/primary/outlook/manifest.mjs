import { writeFileSync } from "node:fs";
import { resolve } from "node:path";
import { fileURLToPath } from "node:url";

const ICON_SMALL_PX = 16;
const ICON_MEDIUM_PX = 32;
const ICON_LARGE_PX = 64;
const ICON_HIGH_RESOLUTION_PX = 80;

const INVALID_ORIGIN_MESSAGE = "Use an HTTPS origin, e.g. https://localhost:3000";
const PROVIDER_ICON_SIZES = [ICON_SMALL_PX, ICON_MEDIUM_PX, ICON_LARGE_PX, ICON_HIGH_RESOLUTION_PX];

export function buildManifest({ baseUrl = "https://ready.app", isProvider = false } = {}) {
	const url = new URL(baseUrl);
	if (url.protocol !== "https:" || url.username || url.password || url.pathname !== "/" || url.search || url.hash) {
		throw new Error(INVALID_ORIGIN_MESSAGE);
	}
	const origin = url.origin.replaceAll("&", "&amp;").replaceAll('"', "&quot;");
	const manifest = `<?xml version="1.0" encoding="UTF-8"?>
<OfficeApp xmlns="http://schemas.microsoft.com/office/appforoffice/1.1" xmlns:xsi="http://www.w3.org/2001/XMLSchema-instance" xmlns:bt="http://schemas.microsoft.com/office/officeappbasictypes/1.0" xsi:type="MailApp">
  <Id>20a9792f-729c-4a96-8292-b52b1c5e7cbb</Id>
  <Version>1.0.1.0</Version>
  <ProviderName>Ready Sparkles, Inc.</ProviderName>
  <DefaultLocale>en-US</DefaultLocale>
  <DisplayName DefaultValue="Ready"/>
  <Description DefaultValue="Add Ready video meetings to your Outlook calendar invitations."/>
  <IconUrl DefaultValue="${origin}/icon-32.png"/>
  <HighResolutionIconUrl DefaultValue="${origin}/icon-128.png"/>
  <SupportUrl DefaultValue="https://ready.app/docs"/>
  <AppDomains><AppDomain>${origin}</AppDomain></AppDomains>
  <Hosts><Host Name="Mailbox"/></Hosts>
  <Requirements><Sets><Set Name="Mailbox" MinVersion="1.8"/></Sets></Requirements>
  <FormSettings><Form xsi:type="ItemEdit"><DesktopSettings><SourceLocation DefaultValue="${origin}/outlook/taskpane.html"/></DesktopSettings></Form></FormSettings>
  <Permissions>ReadWriteItem</Permissions>
  <Rule xsi:type="ItemIs" ItemType="Appointment" FormType="Edit"/>
  <DisableEntityHighlighting>false</DisableEntityHighlighting>
  <VersionOverrides xmlns="http://schemas.microsoft.com/office/mailappversionoverrides" xsi:type="VersionOverridesV1_0">
    <Requirements><bt:Sets DefaultMinVersion="1.8"><bt:Set Name="Mailbox"/></bt:Sets></Requirements>
    <Hosts><Host xsi:type="MailHost"><DesktopFormFactor>
      <FunctionFile resid="Taskpane.Url"/>
      <ExtensionPoint xsi:type="AppointmentOrganizerCommandSurface"><OfficeTab id="TabDefault"><Group id="Ready.Group">
        <Label resid="Ready.Label"/>
        <Control xsi:type="Button" id="Ready.AddMeeting"><Label resid="Add.Label"/>
          <Supertip><Title resid="Add.Label"/><Description resid="Add.Description"/></Supertip>
          <Icon><bt:Image size="16" resid="Icon.16"/><bt:Image size="32" resid="Icon.32"/><bt:Image size="80" resid="Icon.80"/></Icon>
          <Action xsi:type="ShowTaskpane"><SourceLocation resid="Taskpane.Url"/></Action>
        </Control>
      </Group></OfficeTab></ExtensionPoint>
    </DesktopFormFactor></Host></Hosts>
    <Resources>
      <bt:Images><bt:Image id="Icon.16" DefaultValue="${origin}/outlook/icon-16.png"/><bt:Image id="Icon.32" DefaultValue="${origin}/icon-32.png"/><bt:Image id="Icon.80" DefaultValue="${origin}/outlook/icon-80.png"/></bt:Images>
      <bt:Urls><bt:Url id="Taskpane.Url" DefaultValue="${origin}/outlook/taskpane.html"/></bt:Urls>
      <bt:ShortStrings><bt:String id="Ready.Label" DefaultValue="Ready"/><bt:String id="Add.Label" DefaultValue="Add Ready meeting"/></bt:ShortStrings>
      <bt:LongStrings><bt:String id="Add.Description" DefaultValue="Create a Ready meeting and add its join link and dial-in details to this invitation."/></bt:LongStrings>
    </Resources>
  </VersionOverrides>
</OfficeApp>\n`;
	if (!isProvider) {
		return manifest;
	}
	// A separate deployment flavor keeps the personal task-pane installation
	// available. The same ID updates an existing installation instead of duplicating it.
	const providerOverrides = `
    <VersionOverrides xmlns="http://schemas.microsoft.com/office/mailappversionoverrides/1.1" xsi:type="VersionOverridesV1_1">
      <Description resid="Provider.Description"/>
      <Requirements><bt:Sets DefaultMinVersion="1.8"><bt:Set Name="Mailbox"/></bt:Sets></Requirements>
      <Hosts><Host xsi:type="MailHost"><DesktopFormFactor>
        <FunctionFile resid="Commands.Url"/>
        <ExtensionPoint xsi:type="AppointmentOrganizerCommandSurface"><OfficeTab id="TabDefault"><Group id="Ready.Provider">
          <Label resid="Provider.Label"/>
          <Control xsi:type="Button" id="Ready.InsertMeeting"><Label resid="Provider.Label"/>
            <Supertip><Title resid="Provider.Label"/><Description resid="Provider.Description"/></Supertip>
            <Icon>${PROVIDER_ICON_SIZES.map((size) => `<bt:Image size="${size}" resid="Provider.Icon.${size}"/>`).join("")}</Icon>
            <Action xsi:type="ExecuteFunction"><FunctionName>insertReadyMeeting</FunctionName></Action>
          </Control>
        </Group></OfficeTab></ExtensionPoint>
      </DesktopFormFactor></Host></Hosts>
      <Resources>
        <bt:Images>${PROVIDER_ICON_SIZES.map((size) => `<bt:Image id="Provider.Icon.${size}" DefaultValue="${origin}/outlook/provider-icon-${size}.png"/>`).join("")}</bt:Images>
        <bt:Urls><bt:Url id="Commands.Url" DefaultValue="${origin}/outlook/commands.html"/></bt:Urls>
        <bt:ShortStrings><bt:String id="Provider.Label" DefaultValue="Ready meeting"/></bt:ShortStrings>
        <bt:LongStrings><bt:String id="Provider.Description" DefaultValue="Add a Ready video meeting to this invitation."/></bt:LongStrings>
      </Resources>
    </VersionOverrides>`;

	return manifest
		.replace("<Version>1.0.1.0</Version>", "<Version>1.1.1.0</Version>")
		.replace("  </VersionOverrides>", `${providerOverrides}\n  </VersionOverrides>`);
}
if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
	if (process.argv.includes("--publish")) {
		[false, true].forEach((isProvider) => {
			const name = isProvider ? "manifest-provider.xml" : "manifest.xml";
			const xml = buildManifest({ baseUrl: "https://ready.app", isProvider });
			writeFileSync(new URL(`./${name}`, import.meta.url), xml);
			writeFileSync(new URL(`../../../public/outlook/${name}`, import.meta.url), xml);
			process.stdout.write(`Published https://ready.app/outlook/${name}.\n`);
		});
	} else {
		const target = process.argv[3] || fileURLToPath(new URL("./manifest.xml", import.meta.url));
		writeFileSync(
			target,
			buildManifest({ baseUrl: process.argv[2], isProvider: process.argv.includes("--provider") }),
		);
		process.stdout.write(`Wrote ${target}.\n`);
	}
}
