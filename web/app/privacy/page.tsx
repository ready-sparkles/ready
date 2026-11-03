import type { ReactElement } from "react";

import { PublicTopbar } from "../../presentation/components/public-topbar";

const PRIVACY_POLICY_DOCUMENT_HTML = `
<h1>Privacy Policy</h1>
        <p class="legal-updated">Last Updated: October 2, 2026</p>

        <p>
          This Privacy Policy explains how Ready Sparkles, Inc., a Delaware corporation operating Ready (&quot;
          <strong>Ready</strong>,&quot; &quot;<strong>we</strong>,&quot; &quot;
          <strong>us</strong>&quot;) collects, uses, shares, and protects personal information in connection with the
          Ready application, the website at ready.app, and all related services, features, AI agents, automations, and
          integrations (collectively, the &quot;
          <strong>Service</strong>&quot;).
        </p>
        <p>
          Ready is currently in <strong>beta</strong>. Our <a href="/terms">Terms of Use</a> govern use of the
          Service. This Privacy Policy explains our data practices; it is not a request for consent. Where consent is
          required, we obtain it separately.
        </p>
        <p>
          If you have questions, contact us at <strong>info@ready.app</strong>.
        </p>

        <section>
          <h2>1. Scope and Roles</h2>
          <p>This Privacy Policy applies to:</p>
          <ul>
            <li>
              <strong>Account holders</strong> - people who sign up for and use Ready (&quot;
              <strong>Users</strong>&quot;).
            </li>
            <li>
              <strong>Meeting participants</strong> - people who join meetings hosted by Users that include the Ready AI
              assistant.
            </li>
            <li>
              <strong>Visitors</strong> - people who browse ready.app.
            </li>
          </ul>
          <p>
            For meeting content (recordings, transcripts, AI outputs), Users act as the controller of that content for
            their meetings, and we process it on Users&apos; behalf in order to provide the Service. Users are
            responsible for the lawfulness of the meetings they host and for obtaining any consents required from
            meeting participants (see our <a href="/terms">Terms of Use</a>, Section 5). Where required by law, we
            will enter into a data processing agreement with Users.
          </p>
          <p>
            For account information, billing data (where applicable), service operations, and security, Ready Sparkles,
            Inc. is the controller.
          </p>
        </section>

        <section>
          <h2>2. Information We Collect</h2>
          <h3>2.1 Information You Provide</h3>
          <ul>
            <li>
              <strong>Account information.</strong> When you sign up using Google or Microsoft OAuth, we receive your
              name, email address, profile image, and the unique account identifier from the provider, along with the
              OAuth scopes you authorize.
            </li>
            <li>
              <strong>Profile and configuration data.</strong> Settings, preferences, AI agent configurations,
              automation workflows, and any custom prompts or instructions you provide.
            </li>
            <li>
              <strong>Communications.</strong> Messages you send us (e.g., support emails, beta feedback).
            </li>
            <li>
              <strong>Billing information.</strong> If you purchase a paid plan or credits, we process customer and
              billing contact details, subscription and transaction records, invoices, and payment status. Payments are
              handled through Stripe.
            </li>
          </ul>

          <h3>2.2 Information from Connected Integrations</h3>
          <p>
            When you authorize Ready to connect to third-party services - including <strong>Google</strong> (Google
            Calendar and Gmail), <strong>Microsoft</strong> (Outlook Calendar and Outlook Mail), <strong>Linear</strong>
            , or other tools you connect - we access only the data and capabilities you grant via that service&apos;s
            OAuth consent flow, and only as needed to provide the features you use.
          </p>

          <h3>2.3 Meeting Content</h3>
          <p>
            Every Ready meeting is automatically recorded, transcribed, and processed by AI as a core function of the
            Service. As a result, we process:
          </p>
          <ul>
            <li>
              <strong>Audio and video</strong> captured from meetings the Service joins;
            </li>
            <li>
              <strong>Transcripts</strong> generated from that audio;
            </li>
            <li>
              <strong>Meeting metadata</strong> such as participant names, email addresses, timestamps, calendar event
              details, and meeting titles;
            </li>
            <li>
              <strong>AI outputs</strong> such as summaries, notes, tasks, extracted entities, coaching feedback, and
              other generated content;
            </li>
            <li>
              <strong>Files and content</strong> shared in the meeting if processed by the Service.
            </li>
          </ul>
          <p>
            We process meeting content to provide the AI assistant during the meeting, generate transcripts and
            summaries, run post-meeting workflows you configure, and otherwise deliver the Service.
          </p>

          <h3 id="meeting-memory">Meeting Memory and People Profiles</h3>
          <p>
            Ready can save details derived from meetings in a participant&apos;s private memory, including People
            profiles that bring together information about people they have met across conversations. These may include
            names, name variants, meeting history, and facts or summaries supported by meeting content. Each memory
            belongs to its account holder within their workspace; it is not a public directory or shared automatically
            with everyone in that workspace. Access remains subject to the holder&apos;s permissions to the underlying
            meeting content.
          </p>
          <p>
            Memory uses meeting content on the account holder&apos;s behalf. The account holder is responsible for an
            appropriate lawful basis and any required participant permissions. This notice does not itself obtain
            consent to recording or memory processing. Memory content can be forgotten using the memory controls.
            Deleting underlying meeting content removes or invalidates the memories supported by it. We retain remaining
            memory and profile information for as long as needed to provide the feature, subject to deletion requests
            and applicable retention obligations. Participants can contact the meeting host or info@ready.app to request
            access, correction, deletion, or exercise applicable rights described in Section 10.
          </p>
          <h3 id="guest-recognition">Optional Guest Browser Recognition</h3>
          <p>
            Where available, guests may choose “Remember me next time” before asking to join. If you opt in, Ready
            stores a first-party recognition cookie containing a random identifier and records your choice, its wording
            version, timestamp, and guest identity on our servers. We use it to associate future guest visits from that
            browser with one person in each relevant participant&apos;s private memory. Your last-used name is filled in
            when you return and can be edited. Entered names are retained as aliases; the cookie grants no access to
            earlier meetings. If you link a verified guest session to an account, existing private profiles can use your
            account name and photo and connect future meetings to the same person.
          </p>
          <p>
            The cookie expires one year after consent and is not extended by subsequent visits. Recognition applies to
            everyone using the same browser, even when they enter different names, so only enable it on a personal
            browser. You can join without enabling it. Turn it off before joining by unchecking “Remember me next time”;
            this revokes the identifier and removes the cookie. Clearing cookies also prevents that browser from
            presenting the identifier. Turning recognition off stops future recognition; it does not automatically
            delete original meeting records or historical profile associations. You can separately request deletion or
            correction as described above. Material changes to this recognition purpose require a new choice.
          </p>

          <h3>2.4 Usage, Device, and Log Information</h3>
          <ul>
            <li>
              <strong>Device and technical information</strong> such as IP address, browser type, operating system,
              device identifiers, and language settings.
            </li>
            <li>
              <strong>Usage data</strong> such as features used, pages viewed, actions taken, and timestamps.
            </li>
            <li>
              <strong>Log and diagnostic data</strong> for security, debugging, abuse prevention, and reliability.
            </li>
          </ul>

          <h3>Analytics</h3>
          <p>
            We do not use Google Analytics or send website visits, meeting activity, or purchases to Google Analytics.
            We retain operational and diagnostic data needed to provide, secure, and improve the Service.
          </p>
          <h3>2.5 Cookies and Similar Technologies</h3>
          <p>
            We use cookies and similar technologies to keep you signed in, remember preferences, secure the Service, and
            understand usage. Where available, we also offer optional guest recognition as described above, enabled only
            after your opt-in. We do not sell your data for advertising. You can control cookies through your browser
            settings, though some features may not work without them.
          </p>
        </section>

        <section>
          <h2>3. How We Use Information</h2>
          <p>We use the information described above to:</p>
          <ul>
            <li>
              Provide the core Service, including hosting meetings, recording, transcribing, generating summaries,
              running AI agents, and executing automated workflows;
            </li>
            <li>Authenticate Users and secure accounts;</li>
            <li>
              Maintain, debug, monitor, and improve the Service (including aggregate, de-identified usage analysis,
              prompt and reliability tuning, UX improvements, and safety measures);
            </li>
            <li>
              Communicate with you about the Service, including beta updates, bug responses, and important notices;
            </li>
            <li>
              Detect, investigate, and prevent fraud, abuse, security incidents, and violations of our Terms of Use;
            </li>
            <li>Comply with legal obligations, respond to lawful requests, and enforce our agreements.</li>
          </ul>
          <p>
            <strong>
              We do not use customer meeting audio, video, transcripts, prompts, files, or AI outputs to train our own
              general-purpose AI models. We also configure our AI providers, where available, so that data sent via
              their APIs is not used to train their models.
            </strong>
          </p>
          <p>
            We may use aggregate or de-identified data, logs, and feedback to improve the Service, refine prompts,
            improve reliability and UX, and improve safety - but not to train foundation models on user meeting content.
          </p>
        </section>

        <section>
          <h2>4. Legal Bases for Processing (EEA / UK Users)</h2>
          <p>
            If you are in the European Economic Area or United Kingdom, we rely on the following legal bases under the
            GDPR / UK GDPR:
          </p>
          <ul>
            <li>
              <strong>Performance of a contract</strong> - to provide the Service you requested under our Terms of Use.
            </li>
            <li>
              <strong>Legitimate interests</strong> - to operate, secure, and improve the Service; prevent fraud and
              abuse; and communicate with Users about the Service. We balance these interests against your rights and
              freedoms.
            </li>
            <li>
              <strong>Consent</strong> - where required (for example, certain optional features or specific data uses).
              You may withdraw consent at any time.
            </li>
            <li>
              <strong>Legal obligation</strong> - where processing is required by applicable law.
            </li>
          </ul>
          <p>
            For meeting content processed on a User&apos;s behalf, the User is responsible for establishing the legal
            basis for processing under applicable law, including obtaining any required consents from meeting
            participants.
          </p>
        </section>

        <section>
          <h2>5. Sub-processors and Third Parties We Share With</h2>
          <p>
            We use the following providers to operate the Service. Providers acting as processors or sub-processors
            handle personal data on our instructions under applicable data processing, confidentiality, and security
            terms. Payment, authentication, and connected service providers may also act as independent controllers for
            their own purposes, such as fraud prevention or legal compliance, as described in their privacy policies.
          </p>
          <div class="legal-table-wrap">
            <table class="legal-table">
              <thead>
                <tr>
                  <th>Provider</th>
                  <th>Purpose</th>
                  <th>Location</th>
                </tr>
              </thead>
              <tbody>
                <tr>
                  <td>
                    <strong>Stripe</strong>
                  </td>
                  <td>Payment processing, checkout, subscription billing, and invoices</td>
                  <td>United States / global infrastructure</td>
                </tr>
                <tr>
                  <td>
                    <strong>Railway</strong>
                  </td>
                  <td>Application hosting and Postgres database</td>
                  <td>United States</td>
                </tr>
                <tr>
                  <td>
                    <strong>LiveKit Cloud</strong>
                  </td>
                  <td>
                    Real-time meeting infrastructure, media transport, room services, and LiveKit Inference
                    transcription
                  </td>
                  <td>United States</td>
                </tr>
                <tr>
                  <td>
                    <strong>OpenAI</strong>
                  </td>
                  <td>
                    AI processing for summaries, extraction, Tasks, mail classification and summaries, meeting briefs,
                    assistant workflows, and related generated outputs
                  </td>
                  <td>United States</td>
                </tr>
                <tr>
                  <td>
                    <strong>Parallel</strong>
                  </td>
                  <td>Meeting preparation and web research enrichment where enabled</td>
                  <td>United States</td>
                </tr>
                <tr>
                  <td>
                    <strong>Ably</strong>
                  </td>
                  <td>Realtime event delivery for app updates and browser sessions</td>
                  <td>United States / global infrastructure</td>
                </tr>
                <tr>
                  <td>
                    <strong>Google</strong>
                  </td>
                  <td>OAuth authentication and authorized Google Calendar and Gmail integrations</td>
                  <td>United States / global infrastructure</td>
                </tr>
                <tr>
                  <td>
                    <strong>Microsoft</strong>
                  </td>
                  <td>OAuth authentication and authorized Outlook Calendar and Outlook Mail integrations</td>
                  <td>United States / global infrastructure</td>
                </tr>
                <tr>
                  <td>
                    <strong>Linear</strong>
                  </td>
                  <td>User-authorized issue and task integration</td>
                  <td>United States / global infrastructure</td>
                </tr>
              </tbody>
            </table>
          </div>
          <p>We may also share information:</p>
          <ul>
            <li>
              <strong>At your direction</strong> - for example, when you authorize an automated workflow to send an
              email, create a calendar event, or update a record in a connected service.
            </li>
            <li>
              <strong>With law enforcement or in response to legal process</strong> - where required by valid legal
              process or to protect rights, safety, property, or to comply with applicable law.
            </li>
            <li>
              <strong>In the event of a business transfer</strong> - if we transition the Service to another operator or
              transfer the Service, information may be transferred as part of that transaction, subject to
              confidentiality, applicable law, and the privacy commitments made when the information was collected. We
              will provide required notices and obtain any required consent. Google user data remains subject to Section
              6 below.
            </li>
          </ul>
          <p>
            We do <strong>not</strong> sell personal information, and we do <strong>not</strong> share personal
            information for cross-context behavioral advertising.
          </p>
          <p>
            This sub-processor list may change as the Service evolves. We will update this policy when we add or replace
            material sub-processors.
          </p>
        </section>

        <section>
          <h2>6. Google API Services User Data Policy and Limited Use</h2>
          <p>
            Ready&apos;s use and transfer of information received from Google APIs adheres to the
            <a href="https://developers.google.com/terms/api-services-user-data-policy">
              Google API Services User Data Policy
            </a>
            , including the <strong>Limited Use</strong> requirements.
          </p>
          <p>Specifically:</p>
          <ul>
            <li>
              We use Google user data only to provide or improve user-facing features of Ready that are prominent and
              requested by the User.
            </li>
            <li>
              We do <strong>not</strong> transfer Google user data to third parties except as necessary to provide or
              improve those user-facing features, to comply with applicable law, or as part of a merger, acquisition, or
              sale of assets with the User&apos;s consent.
            </li>
            <li>
              We do <strong>not</strong> use Google user data for serving advertisements.
            </li>
            <li>
              We do <strong>not</strong> allow humans to read Google user data, except (a) with the User&apos;s
              affirmative agreement for specific messages, (b) as necessary for security purposes such as investigating
              abuse, (c) to comply with applicable law, or (d) where the data has been aggregated and de-identified for
              internal operations consistent with the User Data Policy.
            </li>
          </ul>
          <p>The same principles apply to our handling of Microsoft user data.</p>
        </section>

        <section>
          <h2>7. International Transfers</h2>
          <p>
            We are based in the United States, and our sub-processors primarily process data in the United States. If
            you access the Service from outside the United States, your information will be transferred to and processed
            in the United States and other countries that may have different data-protection laws than your country.
          </p>
          <p>
            For transfers of personal data from the EEA, UK, or Switzerland, we rely on appropriate safeguards permitted
            by applicable law, such as the European Commission&apos;s Standard Contractual Clauses (SCCs), the UK
            Addendum, or equivalent mechanisms offered by our sub-processors. You may request more information about
            these safeguards by contacting us.
          </p>
        </section>

        <section>
          <h2>8. Data Retention</h2>
          <p>
            We retain personal information only as long as needed for the purposes described in this policy, then delete
            or de-identify it. Specifically:
          </p>
          <ul>
            <li>
              <strong>Temporary audio and recording segments</strong> - retained only as long as needed to generate and
              improve transcripts, then automatically deleted. In any event, raw audio is deleted within
              <strong>30 days</strong>.
            </li>
            <li>
              <strong>Transcripts, notes, Tasks, AI outputs, and meeting metadata</strong> - retained until the User
              deletes the meeting, deletes the workspace, deletes their account, or requests deletion. Users can delete
              this content at any time.
            </li>
            <li>
              <strong>Account information</strong> - retained while the account is active and deleted (or de-identified)
              within a reasonable period after account deletion, except where retention is required by law.
            </li>
            <li>
              <strong>Logs and diagnostic data</strong> - retained for up to <strong>90 days</strong> for security,
              debugging, abuse prevention, and reliability.
            </li>
            <li>
              <strong>Backups</strong> - automated backups may persist for a limited additional period before standard
              deletion cycles complete; deleted data is not actively retrieved from backups but is overwritten in the
              normal course.
            </li>
          </ul>
          <p>
            We may retain limited information longer where required by law, to resolve disputes, or to enforce our
            agreements.
          </p>
        </section>

        <section>
          <h2>9. Security</h2>
          <p>
            We use reasonable administrative, technical, and organizational measures to protect personal information,
            including encryption in transit (TLS), encryption at rest where supported by our sub-processors, access
            controls, OAuth-based authentication, and monitoring.
          </p>
          <p>
            However, no system is perfectly secure. You should not transmit highly sensitive data (such as protected
            health information, regulated financial data, or government-classified information) through the Service. If
            you become aware of any security issue, please contact us at <strong>info@ready.app</strong>.
          </p>
        </section>

        <section>
          <h2>10. Your Rights</h2>
          <h3>10.1 Rights in the EEA, UK, and Switzerland</h3>
          <p>
            If you are in the EEA or UK, you may have the following rights under the GDPR or UK GDPR, subject to
            applicable limits. Residents of Switzerland may have similar rights under Swiss data protection law:
          </p>
          <ul>
            <li>
              <strong>Access</strong> - request a copy of personal data we hold about you.
            </li>
            <li>
              <strong>Rectification</strong> - correct inaccurate or incomplete data.
            </li>
            <li>
              <strong>Erasure</strong> - request deletion of your data (&quot;right to be forgotten&quot;).
            </li>
            <li>
              <strong>Restriction</strong> - limit how we process your data in certain circumstances.
            </li>
            <li>
              <strong>Portability</strong> - receive your data in a structured, commonly used, machine-readable format.
            </li>
            <li>
              <strong>Objection</strong> - object to processing based on legitimate interests.
            </li>
            <li>
              <strong>Withdraw consent</strong> - where processing is based on consent, withdraw it at any time without
              affecting prior lawful processing.
            </li>
            <li>
              <strong>Lodge a complaint</strong> - with your local data protection authority (e.g., the UK ICO, the
              Irish DPC, or the authority in your country of residence).
            </li>
          </ul>
          <p>
            To exercise these rights, contact us at <strong>info@ready.app</strong>. We may need to verify your identity
            before responding.
          </p>

          <h3>10.2 Rights Under California Law (CCPA / CPRA)</h3>
          <p>If you are a California resident, you have the following rights, subject to applicable limits:</p>
          <ul>
            <li>
              <strong>Right to know</strong> what personal information we collect, use, disclose, and (if applicable)
              sell or share.
            </li>
            <li>
              <strong>Right to access and portability</strong> - request a copy of your personal information.
            </li>
            <li>
              <strong>Right to delete</strong> personal information we hold about you.
            </li>
            <li>
              <strong>Right to correct</strong> inaccurate personal information.
            </li>
            <li>
              <strong>Right to limit use of sensitive personal information</strong> in certain circumstances.
            </li>
            <li>
              <strong>Right to opt out of &quot;sale&quot; or &quot;sharing&quot;</strong> of personal information for
              cross-context behavioral advertising.
              <strong>We do not sell or share personal information for cross-context behavioral advertising.</strong>
            </li>
            <li>
              <strong>Right to non-discrimination</strong> for exercising your rights.
            </li>
          </ul>
          <p>
            You may exercise these rights by contacting us at <strong>info@ready.app</strong>. You may also designate an
            authorized agent to act on your behalf.
          </p>

          <h3>10.3 Rights for Other Jurisdictions</h3>
          <p>
            Residents of other jurisdictions (such as Virginia, Colorado, Connecticut, Texas, Brazil, and Canada) may
            have similar rights under applicable law. Contact us to exercise any rights you have.
          </p>

          <h3>10.4 Meeting Participants</h3>
          <p>
            If you are a meeting participant (not a Ready User) and want to exercise rights regarding meeting content,
            please contact the meeting host first, as they are the controller of that content. You may also contact us,
            and we will assist where required by law and where we can identify your data.
          </p>
        </section>

        <section>
          <h2>11. Children</h2>
          <p>
            The Service is not directed to, and we do not knowingly collect personal information from, anyone under 18
            years of age. If you believe a child has provided personal information through the Service, contact us and
            we will delete it.
          </p>
        </section>

        <section>
          <h2>12. Automated Decision-Making and AI</h2>
          <p>
            The Service uses AI to generate transcripts, summaries, Tasks, suggestions, drafted communications, and
            other outputs. These outputs are intended to assist you and are not solely automated decisions producing
            legal or similarly significant effects on you within the meaning of GDPR Article 22. AI output may be
            inaccurate, incomplete, or biased - you are responsible for reviewing it before relying on it. See our
            <a href="/terms">Terms of Use</a>, Section 7.
          </p>
        </section>

        <section>
          <h2>13. Changes to This Policy</h2>
          <p>
            We may update this Privacy Policy from time to time. When we make material changes, we will update the
            &quot;Last Updated&quot; date at the top and provide email or in-app notice as required by law, in advance
            where required. We will obtain any consent required before using personal information for a new purpose or
            in a way that is materially inconsistent with the commitments made when it was collected. Continued use of
            the Service does not substitute for that consent or waive your privacy rights.
          </p>
        </section>

        <section>
          <h2>14. Contact</h2>
          <p>For questions, concerns, or to exercise any rights described in this policy:</p>
          <p>
            <strong>Email:</strong> info@ready.app
            <br />
            <strong>Operator:</strong> Ready Sparkles, Inc.
          </p>
        </section>

        <p class="legal-closing">
          Thank you for trying Ready during beta. Your trust matters, and we&apos;ll handle your data accordingly.
        </p>
`;

export default function PrivacyPage(): ReactElement {
  return (
    <main className="legal-page">
      <PublicTopbar surface="light" />
      <article
        className="legal-document"
        // ponytail: static legal HTML keeps existing .legal-document element styles without a copy module file.
        dangerouslySetInnerHTML={{ __html: PRIVACY_POLICY_DOCUMENT_HTML }}
      />
    </main>
  );
}
