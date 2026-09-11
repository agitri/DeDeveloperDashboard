/**
 * Signal, not the firehose. Port of `sync/signal.rs`.
 *
 * A scorer rather than a boolean: mail is genuinely ambiguous in the middle,
 * and a score with reasons attached is something a person can disagree with.
 * The weighting rests on one distinction: structural evidence (who sent it,
 * which headers it carries) outranks lexical evidence (words in the subject).
 */

export interface MailSignals {
  from: string;
  subject: string;
  /** Lowercased header names present on the message. */
  headers: string[];
  /** True when the recipient is on `To:` rather than only Cc/Bcc. */
  addressedDirectly: boolean;
  /** True when this thread already contains a message from the user. */
  repliedBefore: boolean;
}

export function mailSignals(partial: Partial<MailSignals> & Pick<MailSignals, "from" | "subject">): MailSignals {
  return { headers: [], addressedDirectly: false, repliedBefore: false, ...partial };
}

export interface Verdict {
  signal: boolean;
  score: number;
  /** Machine-readable, e.g. `noise:list-unsubscribe`. */
  reasons: string[];
}

/** Above this, a human probably wrote it and probably wants an answer. */
const THRESHOLD = 0;
/** Facts about the message: sender identity, list headers. */
const STRUCTURAL = 4;
/** Guesses about its meaning: words in the subject. */
const LEXICAL = 2;
/** Being written to rather than cc'd. Must outweigh one lexical hit. */
const ADDRESSED = 3;

const ROBOT_LOCALS = [
  "noreply", "no-reply", "no_reply", "donotreply", "do-not-reply", "notifications",
  "notification", "mailer-daemon", "bounce", "bounces", "newsletter", "news", "marketing",
  "billing", "receipts", "invoice", "alerts", "alert", "automated", "auto-confirm", "jenkins",
  "build", "ci", "postmaster", "support-noreply",
];

const ROBOT_HEADERS = [
  "list-unsubscribe", "list-id", "auto-submitted", "x-auto-response-suppress", "precedence",
  "x-campaign-id", "x-mailer-daemon", "feedback-id",
];

/** Subject shapes that *suggest* automation. Weak evidence by design. */
const ROBOT_SUBJECTS = [
  "build failed", "build passed", "build succeeded", "pipeline failed", "deployment succeeded",
  "your receipt", "invoice", "order confirmation", "password reset", "verify your email",
  "unsubscribe", "weekly digest", "daily digest", "newsletter", "security alert",
  "terms of service", "privacy policy",
];

export function classify(mail: MailSignals): Verdict {
  let score = 0;
  const reasons: string[] = [];

  const from = mail.from.toLowerCase();
  // The Rust: last segment after '<', then before '@', trimmed of anything
  // that is not [a-z0-9_-].
  const afterAngle = from.slice(from.lastIndexOf("<") + 1);
  const local = (afterAngle.split("@")[0] ?? "").replace(/^[^a-z0-9_-]+|[^a-z0-9_-]+$/g, "");

  // Structural: who actually sent it.
  if (ROBOT_LOCALS.some((robot) => local === robot || local.startsWith(`${robot}-`))) {
    score -= STRUCTURAL;
    reasons.push(`noise:sender-${local}`);
  }

  for (const raw of mail.headers) {
    const header = raw.toLowerCase();
    if (ROBOT_HEADERS.includes(header)) {
      // List-Unsubscribe is the single most reliable tell.
      score -= header === "list-unsubscribe" ? STRUCTURAL : Math.trunc(STRUCTURAL / 2);
      reasons.push(`noise:${header}`);
    }
  }

  const subject = mail.subject.toLowerCase();
  // Lexical: weaker than a direct address on purpose.
  const hit = ROBOT_SUBJECTS.find((pattern) => subject.includes(pattern));
  if (hit !== undefined) {
    score -= LEXICAL;
    reasons.push(`noise:subject-${hit.replaceAll(" ", "-")}`);
  }

  // Bracketed prefixes are how ticket systems announce themselves: [JIRA].
  if (subject.startsWith("[") && subject.includes("]")) {
    score -= 1;
    reasons.push("noise:bracket-prefix");
  }

  if (mail.addressedDirectly) {
    score += ADDRESSED;
    reasons.push("signal:addressed-to-me");
  }
  if (mail.repliedBefore) {
    // You have already engaged with this thread; it is yours now.
    score += 5;
    reasons.push("signal:in-my-thread");
  }

  return { signal: score > THRESHOLD, score, reasons };
}

/** The item kind a verdict implies; "real mail only" is `WHERE kind = 'mail'`. */
export function kindFor(verdict: Verdict): "mail" | "mail_bulk" {
  return verdict.signal ? "mail" : "mail_bulk";
}
