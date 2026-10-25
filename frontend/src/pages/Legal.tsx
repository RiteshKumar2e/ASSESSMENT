// Draft legal pages. They describe what this codebase actually does; anything the code
// cannot know (operator identity, hosting provider, contact) is marked for the owner.
import type { ReactNode } from "react";
import { PageHead } from "../components/common";

const CONTACT = (import.meta.env.VITE_CONTACT_EMAIL ?? "").trim();
const OPERATOR = (import.meta.env.VITE_OPERATOR_NAME ?? "").trim();

function OwnerItem({ children }: { children: ReactNode }) {
  return <mark className="owner-item">[Owner to complete: {children}]</mark>;
}

function Contact() {
  return CONTACT ? <a href={`mailto:${CONTACT}`}>{CONTACT}</a> : <OwnerItem>contact email (set VITE_CONTACT_EMAIL)</OwnerItem>;
}

function Operator() {
  return OPERATOR ? <>{OPERATOR}</> : <OwnerItem>operator's legal name (set VITE_OPERATOR_NAME)</OwnerItem>;
}

function DraftNotice() {
  return (
    <p className="draft-notice" role="note">
      Draft for owner review. This text describes the application as built; it has not been reviewed by a lawyer and is
      not legal advice. Items marked “Owner to complete” must be filled in before public launch.
    </p>
  );
}

const ELEXON = (
  <a href="https://bmrs.elexon.co.uk/" target="_blank" rel="noopener noreferrer">
    Elexon BMRS<span className="sr-only"> (opens in a new tab)</span>
  </a>
);

export function Privacy() {
  return (
    <>
      <PageHead title="Privacy policy" purpose="What information this application handles, and what it does not." />
      <article className="panel legal">
        <div className="panel-body prose">
          <DraftNotice />
          <h2>Who operates this application</h2>
          <p>
            Wind Forecast Monitor is operated by <Operator />. Questions about this policy: <Contact />.
          </p>
          <h2>Information the application collects</h2>
          <ul>
            <li>There are no user accounts, sign-in, forms or uploads. The application does not ask for personal information.</li>
            <li>
              The application does not set cookies and does not use browser storage (localStorage, sessionStorage or
              IndexedDB).
            </li>
            <li>There are no analytics, advertising or tracking scripts, and no third-party fonts or embeds.</li>
            <li>
              Your filter choices (delivery day, decision cutoff) are kept only in the page address, so they appear in
              your browser history and in any link you share.
            </li>
          </ul>
          <h2>Server and hosting logs</h2>
          <p>
            Like any website, the servers that deliver the application receive technical request data such as IP
            address, browser type, requested address and time. Whether and for how long this is logged depends on the
            hosting provider: <OwnerItem>hosting provider(s), log contents and retention period</OwnerItem>. The
            application code itself does not log IP addresses.
          </p>
          <h2>Data shown in the application</h2>
          <p>
            Wind generation forecasts and actual generation come from public {ELEXON} datasets (WINDFOR and FUELHH).
            They contain no personal data.
          </p>
          <h2>Cookies and consent</h2>
          <p>
            No cookies or similar technologies are used, so no consent banner is shown. If analytics or other optional
            technologies are added later, this policy and a consent mechanism must be updated before they are enabled.
          </p>
          <h2>Your rights</h2>
          <p>
            Because the application does not collect personal data itself, requests about hosting logs should be sent to{" "}
            <Contact />. <OwnerItem>confirm applicable data protection law and supervisory authority</OwnerItem>
          </p>
          <h2>Changes</h2>
          <p>
            This policy will be updated if the application's data practices change. <OwnerItem>effective date</OwnerItem>
          </p>
        </div>
      </article>
    </>
  );
}

export function Terms() {
  return (
    <>
      <PageHead title="Terms of use" purpose="The conditions for using Wind Forecast Monitor." />
      <article className="panel legal">
        <div className="panel-body prose">
          <DraftNotice />
          <h2>Purpose</h2>
          <p>
            Wind Forecast Monitor is an analytical tool operated by <Operator />. It shows historical GB national wind
            forecasts and actual generation for January 2026 and measures forecast accuracy. It is provided to support
            analysis, not to give trading, financial or operational advice.
          </p>
          <h2>Data and accuracy</h2>
          <ul>
            <li>
              Figures are derived from public {ELEXON} data retrieved at a fixed time (shown on the Method &amp; data
              page). Elexon may revise its data, and the application does not update automatically.
            </li>
            <li>
              The decision cutoff, forecast selection and metric definitions are documented assumptions. Results change
              if those assumptions change.
            </li>
            <li>
              Wind forecast error is not the volume of electricity a buyer must purchase. Demand, prices and other
              generation are outside the application's scope.
            </li>
            <li>Data may contain gaps or errors. Check results before relying on them for decisions.</li>
          </ul>
          <h2>Use of BMRS data</h2>
          <p>
            BMRS data remains subject to Elexon's own terms. Anyone reusing exported data should check those terms.
          </p>
          <h2>Acceptable use</h2>
          <p>
            Do not attempt to disrupt the service, probe it for vulnerabilities without permission, or send automated
            traffic at a volume that degrades it for others.
          </p>
          <h2>Availability and liability</h2>
          <p>
            The application is provided as is, without guarantees of availability or fitness for a particular purpose.{" "}
            <OwnerItem>limitation of liability wording, reviewed for the applicable jurisdiction</OwnerItem>
          </p>
          <h2>Contact and governing law</h2>
          <p>
            Questions: <Contact />. <OwnerItem>governing law and jurisdiction</OwnerItem>
          </p>
        </div>
      </article>
    </>
  );
}
