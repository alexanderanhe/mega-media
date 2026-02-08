const RESEND_API_URL = "https://api.resend.com/emails";

export async function sendVerificationEmail(input: { to: string; name?: string; code: string }) {
  const apiKey = process.env.RESEND_API_KEY;
  const from = process.env.RESEND_FROM_EMAIL;
  if (!apiKey || !from) {
    throw new Error("Missing RESEND_API_KEY or RESEND_FROM_EMAIL");
  }

  const greeting = input.name ? `Hola ${input.name},` : "Hola,";
  const text = `${greeting}\n\nTu codigo de acceso es: ${input.code}\n\nEste codigo expira en 10 minutos.\n`;

  const res = await fetch(RESEND_API_URL, {
    method: "POST",
    headers: {
      Authorization: `Bearer ${apiKey}`,
      "Content-Type": "application/json",
    },
    body: JSON.stringify({
      from,
      to: input.to,
      subject: "Codigo de acceso",
      text,
    }),
  });

  if (!res.ok) {
    const payload = await res.text().catch(() => "");
    throw new Error(payload || "Failed to send email");
  }
}
