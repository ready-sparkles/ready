import { addon } from "../../../composition/google-calendar/addon";

const RECONNECT_TITLE = "Reconnect Ready";
const RECONNECT_BODY =
  "Ready could not verify the account connected to this add-on. Reconnect before opening the web app.";
const AUTHORIZE_TITLE = "Authorize Ready";
const UNAVAILABLE_TITLE = "Ready couldn't connect";
const AUTHORIZE_BODY = "Authorize this add-on with the Google account you want to use with Ready, then try again.";
const UNAVAILABLE_BODY = "Ready is temporarily unavailable. Your Calendar event has not been changed.";
const RETRY_LABEL = "Try again";
const RECONNECT_LABEL = "Reconnect";
const OPEN_READY_LABEL = "Open Ready";
const RETRY_FUNCTION = "handleRetryReadyConnection";
const DOCS_PATH = "/docs/google-calendar-addon";

type CardWidget = object;
type CardSection = { addWidget: (widget: CardWidget) => CardSection };
type Card = object;
type CardBuilder = {
  setHeader: (header: object) => CardBuilder;
  addSection: (section: CardSection) => CardBuilder;
  build: () => Card;
};
type CardAction = { setFunctionName: (name: string) => CardAction };
type OpenLink = { setUrl: (url: string) => OpenLink };
type TextButton = {
  setText: (text: string) => TextButton;
  setOnClickAction: (action: CardAction) => TextButton;
  setOpenLink: (link: OpenLink) => TextButton;
};

declare const CardService: {
  newCardSection: () => CardSection;
  newTextParagraph: () => { setText: (text: string) => CardWidget };
  newCardBuilder: () => CardBuilder;
  newCardHeader: () => { setTitle: (title: string) => object };
  newTextButton: () => TextButton;
  newAction: () => CardAction;
  newOpenLink: () => OpenLink;
  newActionResponseBuilder: () => {
    setNavigation: (navigation: object) => { build: () => object };
  };
  newNavigation: () => { updateCard: (card: Card) => object };
};

const buildCard = ({ title, body, button }: { title: string; body: string; button?: CardWidget }): Card => {
  const section = CardService.newCardSection().addWidget(CardService.newTextParagraph().setText(body));
  if (button !== undefined) {
    section.addWidget(button);
  }

  return CardService.newCardBuilder()
    .setHeader(CardService.newCardHeader().setTitle(title))
    .addSection(section)
    .build();
};

const retryButton = (text: string): TextButton =>
  CardService.newTextButton().setText(text).setOnClickAction(CardService.newAction().setFunctionName(RETRY_FUNCTION));

const failureCard = ({
  webBaseUrl,
  isAuthenticationError,
}: {
  webBaseUrl: string;
  isAuthenticationError: boolean;
}): Card =>
  buildCard({
    title: isAuthenticationError ? AUTHORIZE_TITLE : UNAVAILABLE_TITLE,
    body: `${isAuthenticationError ? AUTHORIZE_BODY : UNAVAILABLE_BODY}<br><br><a href="${webBaseUrl}${DOCS_PATH}">Troubleshoot the add-on</a>.`,
    button: retryButton(RETRY_LABEL),
  });

export const onHomepage = (): Card => {
  const flow = addon();
  const result = flow.homepage();
  if (result.errorType === "reconnect") {
    return buildCard({ title: RECONNECT_TITLE, body: RECONNECT_BODY, button: retryButton(RECONNECT_LABEL) });
  }
  if (result.copy === undefined) {
    return failureCard({
      webBaseUrl: flow.webBaseUrl(),
      isAuthenticationError: result.errorType === "authentication",
    });
  }

  return buildCard({
    title: result.copy.title,
    body: result.copy.body,
    button: CardService.newTextButton()
      .setText(OPEN_READY_LABEL)
      .setOpenLink(CardService.newOpenLink().setUrl(result.signInUrl)),
  });
};

export const handleRetryReadyConnection = (): object => {
  addon().clearAuth();

  return CardService.newActionResponseBuilder()
    .setNavigation(CardService.newNavigation().updateCard(onHomepage()))
    .build();
};
