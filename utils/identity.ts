export const normalizeEmail = (value: unknown) =>
  String(value || "").trim().toLowerCase();

export const normalizeMobile = (value: unknown) => {
  const raw = String(value || "").trim();
  const hasLeadingPlus = raw.startsWith("+");
  const digits = raw.replace(/\D/g, "");
  return `${hasLeadingPlus ? "+" : ""}${digits}`;
};

export const isValidMobile = (value: string) => /^\+?\d{7,15}$/.test(value);

export const mobileLookup = (mobile: string) => {
  const digits = mobile.replace(/\D/g, "");
  const separators = "[\\s()\\-]*";
  const formattedDigits = digits.split("").map((digit) => `${digit}${separators}`).join("");
  return new RegExp(`^\\+?${separators}${formattedDigits}$`);
};

