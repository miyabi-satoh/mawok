/** メールを送る。送れなければ投げる。 */
export async function sendMail(env: Env, to: string, subject: string, text: string): Promise<void> {
	if (env.MAIL_LOG_ONLY === '1') {
		console.log(`[mail] to=${to}\n${text}`);
		return;
	}
	if (!env.RESEND_API_KEY) throw new Error('RESEND_API_KEY is not set');

	const res = await fetch('https://api.resend.com/emails', {
		method: 'POST',
		headers: {
			authorization: `Bearer ${env.RESEND_API_KEY}`,
			'content-type': 'application/json'
		},
		body: JSON.stringify({
			from: env.MAIL_FROM,
			to: [to],
			subject,
			text
		})
	});
	if (!res.ok) throw new Error(`Resend responded ${res.status}: ${await res.text()}`);
}
