import type { ReactElement } from "react";

import { PublicTopbar } from "../../presentation/components/public-topbar";

const TERMS_DOCUMENT_HTML = `<article class="legal-document"><h1>Terms of Use</h1>
        <p class="legal-updated">Last Updated: September 16, 2026</p>

        <p class="legal-notice">
          PLEASE READ THESE TERMS CAREFULLY. THEY CONTAIN IMPORTANT INFORMATION ABOUT YOUR LEGAL RIGHTS, INCLUDING A
          BINDING ARBITRATION CLAUSE, CLASS ACTION WAIVER, AND LIMITATIONS OF LIABILITY. BY ACCEPTING THESE TERMS WHEN
          PRESENTED TO YOU, YOU AGREE TO BE BOUND BY THEM.
        </p>

        <section>
          <h2>1. Acceptance of Terms</h2>
          <p>
            These Terms of Use (&quot;Terms&quot;) form a binding legal agreement between you (&quot;you,&quot;
            &quot;User&quot;) and Ready Sparkles, Inc., a Delaware corporation operating Ready (&quot;Ready,&quot;
            &quot;we,&quot; &quot;us,&quot; &quot;Operator&quot;) governing your access to and use of the Ready
            application, website at ready.app, and all related services, features, AI agents, automations, and
            integrations (collectively, the &quot;Service&quot;).
          </p>
          <p>
            By accepting these Terms when they are presented during signup or another access flow, you agree to be bound
            by them. Our Privacy Policy explains how we handle personal data. If you do not agree to these Terms, do not
            use the Service. If you use Ready on behalf of an organization, you represent that you have authority to
            bind that organization; otherwise, you may use Ready only on your own behalf.
          </p>
          <p>
            You must be at least 18 years old and legally able to enter into a binding contract in your jurisdiction to
            use the Service.
          </p>
        </section>

        <section>
          <h2>2. Beta Software &mdash; Important Notice</h2>
          <p>The Service is currently in beta testing. This means:</p>
          <ul>
            <li>
              The Service is provided for evaluation purposes and may be incomplete, unstable, or contain errors, bugs,
              or security vulnerabilities.
            </li>
            <li>
              Features may be added, changed, removed, suspended, or terminated, subject to the notice and other
              protections described below and required by applicable law.
            </li>
            <li>
              Data loss, service interruptions, inaccurate output, or failures of AI agents and automations are possible
              and expected.
            </li>
            <li>
              The Service is not recommended for use in any context where errors, downtime, or data loss could cause
              harm - including legal, medical, financial, regulated, safety-critical, confidential, or business-critical
              settings.
            </li>
            <li>
              We may collect usage data, logs, and feedback to improve the Service. Such collection is governed by our
              Privacy Policy and applicable law.
            </li>
            <li>
              We do not guarantee that the beta program or Service will continue, remain available indefinitely, or
              become a generally available product. This applies to both free and paid accounts.
            </li>
          </ul>
          <p>
            <strong>Discontinuing the beta or Service.</strong> We may decide at any time to end the beta program or
            discontinue all or part of the Service for legitimate operational, financial, security, or legal reasons.
            Paying for a subscription or purchasing credits does not guarantee that we will continue operating the beta
            or Service, or release a replacement product. We will provide reasonable advance notice of a planned
            shutdown, except where earlier action is reasonably necessary for security or legal reasons or circumstances
            beyond our reasonable control, and will provide any notice required by law.
          </p>
          <p>
            If we permanently discontinue a paid Service, we will stop future billing for that Service and provide any
            refunds for unused prepaid subscription periods or purchased credits, and any other remedies, required by
            applicable law or your purchase terms. Nothing in these Terms permits us to retain payments where a refund
            is legally required or excludes your non-waivable rights. Where reasonably practicable, we will give you an
            opportunity to retrieve Your Content before shutdown, subject to applicable retention, deletion, and
            security requirements.
          </p>
          <p>You use the beta subject to these limitations and your rights under applicable law.</p>
        </section>

        <section>
          <h2>3. Description of the Service</h2>
          <p>Ready is an AI-native meeting application. Core, always-on features of the Service include:</p>
          <ul>
            <li>
              Automatic recording and transcription of every meeting. Recording and transcription are intrinsic to how
              the Service works and cannot be disabled. The AI assistant requires the transcript to function.
            </li>
            <li>
              AI assistant participation. An AI assistant joins meetings as a visible, labeled participant and may take
              notes, speak, execute tasks, and interact with participants based on your configuration.
            </li>
            <li>
              Automated post-meeting workflows. The Service may, based on your configuration, draft follow-up emails,
              create calendar events, update documents, or interact with other connected services after a meeting ends.
            </li>
            <li>
              Third-party integrations. The Service integrates with Google, Microsoft, Linear, and other authorized
              third-party services via API access.
            </li>
          </ul>
          <p>
            To support participant awareness, the Service includes built-in structural disclosures, including: (a)
            automatic insertion of a recording and AI-presence notice into calendar invites scheduled through the
            Service; (b) the AI assistant joining meetings as a clearly labeled participant indicating recording is
            active; and (c) an audible announcement when the assistant joins. Section 5 describes the legal effect and
            limits of these disclosures.
          </p>
          <p>
            The exact behavior of AI agents and automated workflows depends on your configuration and the inputs they
            receive. AI output can be inaccurate, biased, fabricated (&quot;hallucinated&quot;), or otherwise wrong. You
            are solely responsible for reviewing and verifying any AI output before relying on it or allowing it to take
            consequential actions. Ready does not provide legal, medical, financial, or other professional advice and is
            not an emergency service. Do not rely on it for emergency communications or decisions affecting safety or
            legal rights without appropriate human review.
          </p>
        </section>

        <section>
          <h2>4. Account Registration and Authentication</h2>
          <p>
            To use the Service, you must authenticate using a Google or Microsoft account. By doing so, you authorize us
            to access certain data and capabilities from those accounts as disclosed during the OAuth consent flow and
            in our Privacy Policy.
          </p>
          <p>You agree to:</p>
          <ul>
            <li>Provide accurate, current, and complete information;</li>
            <li>Maintain the security of your authentication credentials;</li>
            <li>Promptly notify us of any unauthorized access or suspected breach;</li>
            <li>
              Be responsible for your authorized use of the account and take reasonable steps to prevent unauthorized
              access; this does not make you responsible for incidents caused by our breach of duty.
            </li>
          </ul>
          <p>
            You may not share your account, allow others to use it, or use another person&apos;s account without
            permission.
          </p>
        </section>

        <section>
          <h2>4A. Workspaces, Paid Plans, and Credits</h2>
          <p>
            <strong>Workspace authority.</strong> Workspace owners and authorized administrators manage membership,
            access, integrations, and billing. Only authorize purchases or changes you are entitled to make for your
            organization. Adding or removing billable members may change subscription charges under the pricing and
            billing terms disclosed when you purchase. Workspace access to content depends on your role and sharing
            settings; do not assume content shared with a workspace is private from its authorized members.
          </p>
          <p>
            <strong>Subscriptions and renewal.</strong> Prices, billing intervals, included usage, applicable taxes, and
            any seat-based charges are disclosed before purchase. Where you expressly authorize a recurring
            subscription, it renews automatically for the disclosed billing interval until canceled. We will obtain any
            consent and provide acknowledgments, reminders, and notices required by law. Changes to renewal prices will
            be notified in advance and apply prospectively, with an opportunity to cancel and any consent required by
            law. Acceptance of these Terms alone does not authorize a charge.
          </p>
          <p>
            <strong>Cancellation.</strong> An authorized workspace billing administrator can cancel renewal through
            Settings → Billing → Adjust plan. Contact info@ready.app if you cannot access cancellation. Unless you
            request otherwise and we agree, cancellation takes effect at the end of the paid period, with access
            continuing until then subject to Sections 2 and 16. Disconnecting an integration or simply stopping use does
            not cancel a subscription. Refunds are provided where required by law or your purchase terms; nothing here
            excludes statutory cancellation or refund rights.
          </p>
          <p>
            <strong>Usage credits.</strong> Credits are units of Service usage, not money, deposits, or a transferable
            currency. Included allowances and promotional credits follow the limits and renewal or expiry conditions
            disclosed with the offer. Purchased credits do not expire through passage of time, but their use depends on
            the Service remaining available, subject to Section 2 and applicable refund rights. Unused trial benefits do
            not become a paid balance. The amount of AI usage available depends on the features used; a meeting
            allowance does not promise unlimited processing or a particular meeting length.
          </p>
        </section>

        <section>
          <h2>5. Recording, Transcription, AI Participation, and Consent</h2>
          <p>This section is critical. Read it carefully.</p>
          <h3>5.1 Recording and Transcription Are Always On</h3>
          <p>
            Every meeting conducted with the Service is automatically recorded, transcribed, and processed by AI. This
            is a core, intrinsic feature of Ready and cannot be disabled while using the Service. By scheduling,
            hosting, or joining a meeting through the Service, you acknowledge and accept that recording, transcription,
            and AI processing will occur.
          </p>
          <p>
            If you do not want a particular conversation recorded, transcribed, or processed by AI, do not use the
            Service for that conversation.
          </p>

          <h3>5.2 Built-In Structural Disclosures</h3>
          <p>
            To support participant awareness, the Service provides the following built-in disclosures, which the
            Operator may modify, improve, or change in form at any time:
          </p>
          <ul>
            <li>
              Calendar invite notice. Meetings scheduled through the Service include an automatically inserted notice in
              the calendar invite informing invitees that the meeting will be recorded, transcribed, and include an AI
              assistant.
            </li>
            <li>
              Visible labeled participant. The AI assistant joins meetings as a clearly identified participant
              indicating that recording is active.
            </li>
            <li>
              Audible announcement. Upon joining a meeting, the AI assistant audibly announces that the meeting is being
              recorded and transcribed.
            </li>
          </ul>
          <p>
            These structural disclosures are designed to inform meeting participants of the Service&apos;s behavior.
            They do not, on their own, constitute legally sufficient consent in every jurisdiction or context, and the
            Operator makes no representation that they do.
          </p>

          <h3>5.3 Host Authority and Representations</h3>
          <p>By scheduling or hosting a meeting using the Service, you represent and warrant that:</p>
          <ul>
            <li>
              You are the meeting organizer and have the authority to authorize recording, transcription, AI
              participation, and automated post-meeting processing of the meeting;
            </li>
            <li>You have determined which laws apply to your meeting and are responsible for compliance with them;</li>
            <li>
              You are not subject to any contractual, employment, regulatory, or third-party restriction that prohibits
              recording, transcription, or AI participation in the meeting;
            </li>
            <li>
              You will not use the Service for any meeting where recording, transcription, or AI participation is
              prohibited.
            </li>
          </ul>

          <h3>5.4 Your Responsibility for Additional Consents</h3>
          <p>
            Recording, transcription, and AI processing are subject to laws that vary by location, context, and the
            participants involved. All-party consent, workplace consultation, privacy notices, a lawful basis for
            processing, and other safeguards may be required. Do not assume that an invitation, an AI participant, or a
            recording indicator alone satisfies those requirements.
          </p>
          <p>
            The Service&apos;s structural disclosures in Section 5.2 may not satisfy these requirements in every
            jurisdiction or context. As the host, you are responsible for:
          </p>
          <ul>
            <li>Determining which laws apply to each meeting;</li>
            <li>
              Obtaining any additional consents, affirmative acknowledgments, or disclosures required by applicable law
              beyond those provided by the Service&apos;s built-in disclosures;
            </li>
            <li>
              Ceasing use of the Service for the meeting (or for the relevant participant&apos;s portion of the meeting)
              if any participant objects to recording, transcription, or AI participation;
            </li>
            <li>
              Complying with any applicable employment, labor, education, healthcare, biometric, or other
              industry-specific or jurisdiction-specific laws or contractual obligations.
            </li>
          </ul>
          <p>
            You represent and warrant that every use of the Service complies with all applicable laws and that you have
            obtained all necessary consents and permissions. Any indemnification obligation arising from your failure to
            do so is subject to Section 15, including its limitation to business use and its exclusions for claims
            caused by us.
          </p>

          <h3>5.5 Each Party&apos;s Responsibilities</h3>
          <p>
            The Operator&apos;s provision of structural disclosures, the form or wording of any notice, the audible
            announcement, the visible AI participant, or any other feature of the Service does not transfer legal
            compliance responsibility from you to the Operator. The presence, absence, content, or technical functioning
            of any disclosure feature does not constitute legal advice and does not relieve you of your obligations
            under Section 5.4. Nothing in these Terms transfers or excludes obligations that applicable law places on
            the Operator, including our own privacy, security, and recording obligations.
          </p>
        </section>

        <section>
          <h2>6. Acceptable Use</h2>
          <p>You agree not to, and not to permit any agent or third party to, use the Service to:</p>
          <ul>
            <li>Violate any law, regulation, contract, or third-party right;</li>
            <li>Record, transcribe, or process any communication without all legally required consents;</li>
            <li>Harass, defame, threaten, deceive, impersonate, or harm any person;</li>
            <li>
              Process information in violation of confidentiality obligations or protected categories (e.g., regulated
              health, financial, or educational records);
            </li>
            <li>
              Interfere with, disrupt, overload, or attempt to gain unauthorized access to the Service, its
              infrastructure, or other users&apos; accounts or data;
            </li>
            <li>
              Reverse engineer, decompile, scrape, or attempt to extract source code or models, except where applicable
              law expressly permits;
            </li>
            <li>Use the Service to develop, train, or improve a competing product or AI model;</li>
            <li>Generate, distribute, or facilitate spam, phishing, malware, or fraudulent content;</li>
            <li>
              Use AI agents to deceive participants about whether they are interacting with a human or AI in violation
              of any applicable law (including bot disclosure laws);
            </li>
            <li>Use the Service in any safety-critical, life-sustaining, or high-risk system;</li>
            <li>Bypass any access controls, rate limits, or beta participation restrictions.</li>
          </ul>
          <p>
            We may investigate suspected misuse and take proportionate action under Section 16. You may report security
            issues or challenge an account restriction at info@ready.app. Good-faith reporting does not authorize
            accessing another person&apos;s data or disrupting the Service.
          </p>
        </section>

        <section>
          <h2>7. AI Agents and Automated Workflows</h2>
          <p>
            When you configure or authorize an AI agent or automated workflow, you authorize that agent to take actions
            on your behalf, which may include speaking in meetings, sending messages, modifying calendar events,
            accessing files, drafting communications, and interacting with connected services, within the permissions
            and settings you authorize. Instructions in transcripts, files, or other external content may be misleading
            or malicious. Review proposed consequential actions and grant only the access needed. Revoking an
            integration limits future access but may not reverse actions already taken or remove copies already sent to
            a third party.
          </p>
          <p>You acknowledge and agree that:</p>
          <ul>
            <li>
              You are responsible for instructions, permissions, and actions you authorize, and for reviewing
              consequential outputs. This does not make you responsible for our unauthorized actions, breach of these
              Terms, or liability that cannot lawfully be excluded.
            </li>
            <li>
              AI output may be inaccurate, incomplete, offensive, biased, infringing, or otherwise problematic. You must
              review output before relying on it.
            </li>
            <li>
              You are responsible for restricting, supervising, and configuring agents appropriately for the context.
            </li>
            <li>We make no guarantee about agent behavior, output quality, latency, availability, or accuracy.</li>
          </ul>
        </section>

        <section>
          <h2>8. Third-Party Services</h2>
          <p>
            The Service integrates with third-party services including Google, Microsoft, Linear, LiveKit, OpenAI,
            Parallel, Ably, Railway, and other authorized or operational providers needed to run the Service. Your use
            of those services is subject to their own terms and privacy policies.
          </p>
          <p>To the extent outside our reasonable control and permitted by law, we are not responsible for:</p>
          <ul>
            <li>The availability, performance, accuracy, or behavior of third-party services;</li>
            <li>Changes to or termination of third-party APIs or services;</li>
            <li>Any data shared with, processed by, or returned from third parties;</li>
            <li>Third-party billing, fees, or restrictions.</li>
          </ul>
        </section>

        <section>
          <h2>9. Your Content</h2>
          <p>
            &quot;Your Content&quot; means any data, audio, video, transcripts, prompts, instructions, files,
            configurations, or other material you, your meeting participants, or your authorized agents submit to or
            process with the Service.
          </p>
          <p>
            You retain all rights you have in Your Content. By using the Service, you grant us a worldwide,
            non-exclusive, royalty-free license, limited to the rights you can grant, to host, store, copy, transmit,
            process, display, and otherwise use Your Content solely as necessary to (a) provide, maintain, and improve
            the Service for you; (b) operate AI agents and workflows you configure; (c) enforce these Terms; and (d)
            comply with applicable law. This license is subject to our Privacy Policy and does not authorize uses of
            personal data beyond those permitted by applicable law or any separate data processing agreement.
          </p>
          <p>
            You represent and warrant that you have all rights, permissions, and consents necessary to submit Your
            Content to the Service and to authorize the processing described above, including any necessary consents
            from meeting participants.
          </p>
          <p>
            We do not claim ownership of Your Content. Content retention and deletion are governed by our Privacy
            Policy, your settings, applicable law, and Sections 2 and 16. Maintain independent copies of important
            content; Ready is not a substitute for your own records or backups. AI-generated output may not be unique or
            eligible for intellectual property protection, and you must verify that your intended use respects
            third-party rights.
          </p>
        </section>

        <section>
          <h2>10. Intellectual Property</h2>
          <p>
            The Service, including all software, designs, models, prompts, configurations, branding, and content (other
            than Your Content), is owned by the Operator or its licensors and is protected by intellectual property
            laws. We grant you a limited, personal, non-exclusive, non-transferable, revocable license to use the
            Service in accordance with these Terms. No other rights are granted.
          </p>
          <p>
            &quot;Ready&quot; and ready.app are marks of the Operator. You may not use them without prior written
            permission.
          </p>
        </section>

        <section>
          <h2>11. Feedback</h2>
          <p>
            If you submit feedback, suggestions, or ideas about the Service, you grant the Operator a perpetual,
            irrevocable, worldwide, royalty-free, sublicensable license to use them for any purpose without obligation
            or compensation to you.
          </p>
        </section>

        <section>
          <h2>12. Privacy</h2>
          <p>
            Our handling of personal data is described in our Privacy Policy. These Terms do not replace any separate
            consent, data processing agreement, or other safeguards required by applicable law. Do not submit regulated
            data requiring contractual safeguards we have not agreed to provide. Contact info@ready.app about required
            data processing terms before using Ready for that purpose.
          </p>
        </section>

        <section>
          <h2>13. Disclaimers &mdash; No Warranty</h2>
          <p class="legal-all-caps">
            THE SERVICE IS PROVIDED &quot;AS IS&quot; AND &quot;AS AVAILABLE,&quot; WITH ALL FAULTS AND WITHOUT WARRANTY
            OF ANY KIND.
          </p>
          <p class="legal-all-caps">
            TO THE MAXIMUM EXTENT PERMITTED BY APPLICABLE LAW, THE OPERATOR DISCLAIMS ALL WARRANTIES, EXPRESS, IMPLIED,
            OR STATUTORY, INCLUDING BUT NOT LIMITED TO IMPLIED WARRANTIES OF MERCHANTABILITY, FITNESS FOR A PARTICULAR
            PURPOSE, TITLE, NON-INFRINGEMENT, ACCURACY, RELIABILITY, AVAILABILITY, OR THAT THE SERVICE WILL BE
            UNINTERRUPTED, SECURE, ERROR-FREE, OR FREE OF HARMFUL COMPONENTS.
          </p>
          <p class="legal-all-caps">WITHOUT LIMITING THE FOREGOING, THE OPERATOR MAKES NO WARRANTY THAT:</p>
          <ul class="legal-all-caps">
            <li>THE SERVICE WILL MEET YOUR REQUIREMENTS;</li>
            <li>AI OUTPUT WILL BE ACCURATE, COMPLETE, RELIABLE, OR APPROPRIATE FOR ANY PURPOSE;</li>
            <li>AUTOMATED WORKFLOWS WILL EXECUTE CORRECTLY OR AT ALL;</li>
            <li>DATA WILL BE PRESERVED, BACKED UP, OR RECOVERABLE;</li>
            <li>
              THE SERVICE WILL COMPLY WITH ANY PARTICULAR LAW, REGULATION, OR INDUSTRY STANDARD APPLICABLE TO YOUR USE.
            </li>
          </ul>
          <p class="legal-all-caps">
            NO INFORMATION OBTAINED FROM THE SERVICE OR FROM THE OPERATOR CREATES ANY WARRANTY NOT EXPRESSLY STATED IN
            THESE TERMS.
          </p>
          <p>
            Some jurisdictions do not allow the exclusion of certain warranties; in those jurisdictions, the foregoing
            exclusions apply to the maximum extent permitted by law.
          </p>
        </section>

        <section>
          <h2>14. Limitation of Liability</h2>
          <p class="legal-all-caps">TO THE MAXIMUM EXTENT PERMITTED BY APPLICABLE LAW:</p>
          <p class="legal-all-caps">
            (a) THE OPERATOR SHALL NOT BE LIABLE FOR ANY INDIRECT, INCIDENTAL, SPECIAL, CONSEQUENTIAL, EXEMPLARY, OR
            PUNITIVE DAMAGES, OR FOR ANY LOSS OF PROFITS, REVENUE, DATA, GOODWILL, BUSINESS OPPORTUNITY, REPUTATION, OR
            ANTICIPATED SAVINGS, ARISING OUT OF OR RELATING TO THE SERVICE OR THESE TERMS, WHETHER BASED ON CONTRACT,
            TORT (INCLUDING NEGLIGENCE), STRICT LIABILITY, OR ANY OTHER LEGAL THEORY, AND EVEN IF THE OPERATOR HAS BEEN
            ADVISED OF THE POSSIBILITY OF SUCH DAMAGES.
          </p>
          <p class="legal-all-caps">
            (b) THE OPERATOR&apos;S TOTAL CUMULATIVE LIABILITY ARISING OUT OF OR RELATING TO THE SERVICE OR THESE TERMS
            SHALL NOT EXCEED THE GREATER OF (i) THE TOTAL FEES PAID BY YOU TO THE OPERATOR IN THE THREE (3) MONTHS
            IMMEDIATELY PRECEDING THE EVENT GIVING RISE TO THE CLAIM, OR (ii) ONE HUNDRED U.S. DOLLARS ($100).
          </p>
          <p class="legal-all-caps">(c) THESE LIMITATIONS APPLY EVEN IF A REMEDY FAILS OF ITS ESSENTIAL PURPOSE.</p>
          <p>
            (d) Some jurisdictions do not allow the exclusion or limitation of certain damages; in those jurisdictions,
            the Operator&apos;s liability is limited to the maximum extent permitted by law.
          </p>
          <p>
            These limitations do not exclude or limit liability for fraud, willful misconduct, gross negligence, death
            or personal injury caused by negligence, or any other liability that applicable law does not permit us to
            exclude or limit. They do not reduce mandatory consumer remedies or refunds owed under Section 2. Subject to
            those exceptions, these limitations allocate the risks of providing the Service between the parties.
          </p>
        </section>

        <section>
          <h2>15. Indemnification</h2>
          <p>
            If you use the Service for business purposes, to the extent permitted by law, you agree to indemnify the
            Operator and its contractors against third-party claims and reasonable resulting damages and costs,
            including reasonable attorneys&apos; fees, to the extent caused by:
          </p>
          <ul>
            <li>(a) your unlawful use or material breach of these Terms;</li>
            <li>
              (b) Your Content, including any claim that Your Content infringes, misappropriates, or violates any
              third-party right;
            </li>
            <li>(c) unlawful instructions or actions you authorize through agents or workflows;</li>
            <li>
              (d) your failure to obtain required consents from meeting participants for recording, transcription, AI
              participation, or automated processing;
            </li>
            <li>
              (e) your violation of these Terms, applicable law, or any third-party right (including privacy, publicity,
              intellectual property, wiretapping, biometric, or data protection laws);
            </li>
            <li>(f) your misconduct toward meeting participants or third parties.</li>
          </ul>
          <p>
            This obligation does not apply to claims caused by our breach, negligence, or misconduct. We will notify you
            promptly of a claim, allow you to control its defense with reasonably acceptable counsel, and provide
            reasonable cooperation at your expense. You may not settle a claim in a way that admits fault by us or
            imposes non-monetary obligations on us without our consent, which will not be unreasonably withheld. We may
            participate with our own counsel at our expense. This indemnity does not apply to personal consumer use.
          </p>
        </section>

        <section>
          <h2>16. Termination</h2>
          <p>
            We may restrict or suspend access where we reasonably believe it is necessary to address a material breach,
            nonpayment, fraud, unlawful use, or a material security or service risk. We may terminate an account for a
            serious breach or a material breach that remains unresolved after reasonable notice and an opportunity to
            remedy it, where a remedy is possible. Immediate action may be taken where reasonably necessary to prevent
            harm or comply with law. We will give notice and a brief explanation where reasonably practicable and as
            required by law. Shutdowns are governed by Section 2, and free trials by the provisions below. You may stop
            using Ready at any time; cancel paid renewal separately as described in Section 4A. Contact info@ready.app
            to request review of a restriction.
          </p>
          <p>
            <strong>Free trials and usage limits.</strong> Free trials are intended for evaluating Ready in ordinary
            meetings and do not include unlimited AI processing. Any advertised meeting allowance is a maximum, subject
            to the trial usage limits and eligibility conditions disclosed with the offer. Limits may apply to meeting
            duration, AI requests, automated tasks, and other resource-intensive features. Any specific limits will be
            disclosed before they apply; we will not treat a newly introduced limit as a prior breach.
          </p>
          <p>
            We may reasonably limit or pause AI features, or end a free trial, where usage exceeds disclosed limits or
            where we reasonably determine that usage creates excessive processing costs or materially risks the
            availability or security of the Service. We may suspend or terminate a free-trial account for abuse,
            automated or non-meeting use, attempts to bypass limits, repeated creation of accounts to obtain additional
            trials, or continued excessive usage after a warning. These measures may take effect before all trial
            meetings have been used. We will use a proportionate response and provide notice and a brief explanation
            where reasonably practicable. We may act immediately where reasonably necessary to prevent substantial
            ongoing costs, abuse, security risks, or service disruption, subject to any notice or explanation required
            by law.
          </p>
          <p>
            <strong>Trial availability.</strong> We may stop offering free accounts or trials to new users at any time.
            We may change or discontinue existing free trials for legitimate operational, financial, security, or legal
            reasons, with reasonable advance notice and any protections required by applicable law. Ending a free trial
            does not automatically enroll you in a paid plan. Trial benefits have no cash value and do not transfer to a
            paid plan. These free-trial provisions govern termination of free trials and do not limit rights that cannot
            lawfully be waived or excluded.
          </p>
          <p>Upon termination:</p>
          <ul>
            <li>Your license to use the Service ends immediately;</li>
            <li>
              Content and account data will be handled under our Privacy Policy and applicable law, including any
              required retention, access, or deletion rights;
            </li>
            <li>
              Sections that by their nature should survive (including Sections 5, 9-11, 13-15, 17-22) will survive.
            </li>
          </ul>
        </section>

        <section>
          <h2>17. Modifications to the Service and Terms</h2>
          <p>
            We may update the Service or these Terms for legitimate operational, security, legal, or product reasons. We
            will post updated Terms with an effective date and give reasonable advance email or in-app notice of
            material changes. Changes requiring immediate action for security or legal reasons may take effect sooner
            with notice as required by law. Material changes will not apply retroactively to existing disputes or remove
            accrued rights. Where consent is required, we will obtain it before applying the change; merely posting
            updated Terms is not a substitute. If you do not accept a change, you may stop using Ready and cancel
            renewal. Any required refund or other remedy remains available. Service discontinuation is governed by
            Section 2.
          </p>
        </section>

        <section>
          <h2>18. Governing Law and Venue</h2>
          <p>
            These Terms are governed by the laws of the State of California, U.S.A., without regard to its
            conflict-of-laws rules. Subject to Section 19, you and the Operator submit to the exclusive jurisdiction of
            the state courts in Sonoma County, California, and the United States District Court for the Northern
            District of California, for any dispute not subject to arbitration, except where mandatory law gives you the
            right to bring proceedings elsewhere. If you are a consumer, this choice of law does not deprive you of
            mandatory protections in your place of residence.
          </p>
        </section>

        <section>
          <h2>19. Binding Arbitration and Class Action Waiver</h2>
          <p>PLEASE READ THIS SECTION CAREFULLY. IT AFFECTS YOUR LEGAL RIGHTS.</p>
          <p>
            Any dispute, claim, or controversy arising out of or relating to the Service or these Terms
            (&quot;Dispute&quot;) shall be resolved exclusively by binding individual arbitration where a valid
            arbitration agreement applies, except that either party may bring an eligible individual action in small
            claims court, and either party may seek injunctive relief in court for intellectual property infringement.
            This section does not prevent complaints to regulators or exclude claims or remedies that applicable law
            requires to remain available in court, including non-waivable public injunctive relief.
          </p>
          <p>
            Arbitration will be administered by the American Arbitration Association (AAA) under its applicable Consumer
            Arbitration Rules and Consumer Due Process Protocol, available at adr.org. Fees will be allocated under
            those rules and applicable law, and we will pay the fees assigned to the business. If AAA declines to
            administer because of our failure to comply with its requirements, you may bring the dispute in a court with
            jurisdiction.
          </p>
          <p>
            You may choose a remote hearing. Any in-person hearing location will be determined under AAA rules and
            applicable law, taking account of your ability to participate.
          </p>
          <p>
            The arbitrator&apos;s decision is binding, subject to judicial review allowed by law. Judgment may be
            entered in any court of competent jurisdiction.
          </p>
          <p>
            <strong>Class Action Waiver.</strong> You and the Operator agree that Disputes will be resolved only on an
            individual basis to the extent permitted by law. Neither party may bring or participate in any class,
            collective, consolidated, or representative action. The arbitrator may not consolidate claims or preside
            over a class proceeding. If this waiver is held unenforceable, the entire arbitration provision is void.
          </p>
          <p>
            <strong>Opt-Out.</strong> You may opt out of this arbitration provision by sending an email to
            info@ready.app within 30 days of first accepting these Terms. The notice must include your name, account
            email, and a clear statement that you opt out.
          </p>
        </section>

        <section>
          <h2>20. Export, Sanctions, and Compliance</h2>
          <p>
            You represent that you are not located in, and not a national or resident of, any country subject to U.S.
            embargo or designated by the U.S. government as a &quot;terrorist supporting&quot; country, and that you are
            not on any U.S. government list of prohibited or restricted parties. You agree to comply with all applicable
            export control and sanctions laws.
          </p>
        </section>

        <section>
          <h2>21. Miscellaneous</h2>
          <p>
            <strong>Entire Agreement.</strong> These Terms, applicable purchase terms, and any separate agreement we
            sign with you are the entire agreement between you and the Operator regarding the Service. Our Privacy
            Policy describes our handling of personal data, and nothing in this clause reduces our commitments under
            that policy. A signed agreement controls a conflict within its scope, and specific purchase terms control
            billing conflicts. Nothing here excludes liability for misleading statements or other non-waivable rights.
          </p>
          <p>
            <strong>Severability.</strong> Except as expressly provided in Section 19, an invalid or unenforceable
            provision will be severed, or limited only to the extent a court may lawfully do so, while the remaining
            provisions continue in effect. This does not authorize enforcement of an unfair term or removal of mandatory
            customer protections.
          </p>
          <p>
            <strong>No Waiver.</strong> Failure to enforce any right or provision is not a waiver.
          </p>
          <p>
            <strong>Assignment and change of operator.</strong> To the extent permitted by applicable law, you agree
            that we may assign our rights and transfer our obligations under these Terms and applicable purchase terms
            to an affiliate that takes over operating Ready, or to a successor that acquires the Service or
            substantially all assets used to operate it, including through reorganization, merger, or sale. No further
            consent is required unless applicable law or a separate agreement with you requires it. Ownership of the
            product&apos;s intellectual property alone does not transfer customer agreements.
          </p>
          <p>
            The successor must agree in writing to assume the obligations transferred to it, including applicable
            prepaid service commitments, credit balances, refund obligations, and privacy commitments. The transfer must
            not reduce your contractual protections or mandatory rights. We will notify you of the successor&apos;s
            legal identity, contact details, and the effective date, in advance where reasonably practicable and
            whenever required by law. After the transfer takes effect, references to the Operator mean the successor for
            the transferred Service and obligations.
          </p>
          <p>
            A transfer does not by itself release either party from liability already incurred. Any release of the
            former operator or substitution that requires a separate agreement or consent will take effect only when
            those legal requirements are satisfied. The former operator retains the benefit of applicable limitations,
            defenses, and dispute provisions for claims relating to its operation of the Service, subject to the
            exceptions and mandatory rights in these Terms. You may not assign this agreement without our prior written
            consent, which will not be unreasonably withheld, except where applicable law permits assignment without
            consent.
          </p>
          <p>
            <strong>Data in a transfer.</strong> Any transfer of personal data remains subject to our Privacy Policy,
            applicable data protection law, and provider restrictions. Agreement to this assignment clause is not a
            substitute for any separate consent or safeguards required for a data transfer, including consent required
            for Google user data.
          </p>
          <p>
            <strong>Force Majeure.</strong> To the extent permitted by law, the Operator is not liable for a failure or
            delay to the extent caused by events beyond its reasonable control, including natural disasters, internet or
            third-party service outages, cyberattacks, war, pandemic, or government action, despite reasonable efforts
            to prevent or mitigate their effects. This clause does not excuse our own breach of duty, remove required
            refunds or notices, or limit rights that cannot lawfully be excluded.
          </p>
          <p>
            <strong>Relationship.</strong> No agency, partnership, joint venture, or employment relationship is created
            by these Terms.
          </p>
          <p>
            <strong>Headings.</strong> Section headings are for convenience only and have no legal effect.
          </p>
          <p>
            <strong>Notices.</strong> We may give notices by email, in-app notification, or posting at ready.app,
            subject to the specific notice requirements in these Terms and applicable law. A general website posting
            does not replace direct notice or consent where required.
          </p>
        </section>

        <section>
          <h2>22. Contact</h2>
          <p>Questions, notices, or arbitration opt-out requests may be sent to:</p>
          <p>
            Email: info@ready.app
            <br />
            Operator: Ready Sparkles, Inc.
          </p>
        </section>

        <p class="legal-notice">
          By accepting these Terms when they are presented to you, you acknowledge that you have read and understand
          them and agree to be bound by them.
        </p></article>`;

export default function TermsPage(): ReactElement {
  return (
    <main className="legal-page">
      <PublicTopbar surface="light" />
      <div dangerouslySetInnerHTML={{ __html: TERMS_DOCUMENT_HTML }} />
    </main>
  );
}
