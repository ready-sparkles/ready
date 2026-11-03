import { emailDomain, isPublicEmailDomain } from "@readymeet/shared";

// These addresses identify an email/hosting service, never someone's employer.
const nonCompanyDomains = new Set([
  "pm.me",
  "fastmail.com",
  "fastmail.fm",
  "hey.com",
  "mailbox.org",
  "tuta.com",
  "tutanota.com",
  "duck.com",
  "simplelogin.com",
  "simplelogin.io",
  "anonaddy.com",
  "privaterelay.appleid.com",
  "users.noreply.github.com",
  "github.io",
  "outlook.office.com",
]);
const compoundSuffixes = new Set(["co.uk", "org.uk", "com.au", "net.au", "co.nz", "co.jp", "co.in", "com.br", "co.za"]);

const DOMAIN_LABEL_INDEX = 0;
const TWO_PART_SUFFIX_SIZE = 2;
const THREE_PART_SUFFIX_SIZE = 3;
const MIN_MULTI_LEVEL_PARTS = 2;

function isInvalidEmailShape(normalized: string): boolean {
  return !/^[^\s@]+@[^\s@]+$/.test(normalized);
}

function isInvalidCompanyDomain(domain: string): boolean {
  return domain === "" || !/^(?:[a-z0-9](?:[a-z0-9-]*[a-z0-9])?\.)+[a-z]{2,}$/.test(domain);
}

function rootDomainParts(input: { parts: string[]; suffix: string }): { root: string; suffix: string } {
  const rootParts = input.parts.slice(
    compoundSuffixes.has(input.suffix) ? -THREE_PART_SUFFIX_SIZE : -TWO_PART_SUFFIX_SIZE,
  );

  return { root: rootParts.join("."), suffix: input.suffix };
}

function isHostedConsumerDomain(root: string): boolean {
  return /^(gmail|googlemail|hotmail|outlook|live|yahoo|gmx|yandex)\./.test(root);
}

function isLocalOrExampleDomain(root: string): boolean {
  return /(?:^|\.)(local|localhost|test|invalid|example)$/.test(root) || /^(example\.(com|org|net))$/.test(root);
}

function isUnsupportedPublicSuffix(input: { parts: string[]; suffix: string }): boolean {
  return (
    input.parts.length > MIN_MULTI_LEVEL_PARTS &&
    !compoundSuffixes.has(input.suffix) &&
    /^(co|com|org|net|ac|edu|gov)\./.test(input.suffix)
  );
}

export function memoryCompanyDomain(email: string): string | null {
  const normalized = email.trim().toLowerCase();
  if (isInvalidEmailShape(normalized)) {
    return null;
  }
  const domain = emailDomain(normalized);
  if (domain === null || isInvalidCompanyDomain(domain)) {
    return null;
  }
  const parts = domain.split(".");
  const suffix = parts.slice(-TWO_PART_SUFFIX_SIZE).join(".");
  const { root } = rootDomainParts({ parts, suffix });
  if (root === suffix && compoundSuffixes.has(suffix)) {
    return null;
  }
  if (isPublicEmailDomain(root) || nonCompanyDomains.has(domain) || nonCompanyDomains.has(root)) {
    return null;
  }
  if (isHostedConsumerDomain(root)) {
    return null;
  }
  if (isLocalOrExampleDomain(root)) {
    return null;
  }
  // Don't turn unsupported multi-level public suffixes or hosted identities into employers.
  if (isUnsupportedPublicSuffix({ parts, suffix })) {
    return null;
  }

  return root;
}

function companyNameFromDomain(domain: string): string | null {
  const label = domain.split(".")[DOMAIN_LABEL_INDEX];
  if (label === undefined || label === "") {
    return null;
  }
  if (label.startsWith("xn--")) {
    return null;
  }

  return label
    .split("-")
    .filter((word) => word !== "")
    .map((word) => {
      const firstCharacter = word.charAt(0);
      if (firstCharacter === "") {
        return "";
      }

      return firstCharacter.toUpperCase() + word.slice(1);
    })
    .join(" ");
}

function resolveCompanyNameFromResearch(input: {
  domain: string;
  companies: { name: string | null; website: string | null }[];
}): string | null {
  const matched = input.companies.find((company) => {
    const companyName = company.name?.trim();
    const website = company.website;
    if (companyName === undefined || companyName === "" || website === null || website === "") {
      return false;
    }
    try {
      const host = new URL(website).hostname;

      return memoryCompanyDomain(`company@${host}`) === input.domain;
    } catch (error) {
      if (error instanceof Error) {
        return false;
      }

      throw error;
    }
  });
  if (matched === undefined) {
    return null;
  }

  const companyName = matched.name?.trim();
  if (companyName === undefined || companyName === "") {
    return null;
  }

  return companyName;
}

export function resolveMemoryCompany(input: {
  emails: string[];
  companies?: { name: string | null; website: string | null }[];
}): { companyName: string | null; companyDomain: string | null } {
  const companies = input.companies ?? [];
  const domains = [
    ...new Set(input.emails.map(memoryCompanyDomain).filter((domain): domain is string => domain !== null)),
  ];
  // Multiple employers/aliases need stronger evidence; do not arbitrarily select one.
  if (domains.length !== 1) {
    return { companyName: null, companyDomain: null };
  }
  const domain = domains[0];
  if (domain === undefined) {
    return { companyName: null, companyDomain: null };
  }
  const researchedName = resolveCompanyNameFromResearch({ domain, companies });
  if (researchedName !== null) {
    return { companyName: researchedName, companyDomain: domain };
  }
  const derivedName = companyNameFromDomain(domain);
  if (derivedName === null) {
    return { companyName: null, companyDomain: null };
  }

  return {
    companyName: derivedName,
    companyDomain: domain,
  };
}
