// SMTP-заглушка на этапе MVP (раздел 9): код печатается в лог backend.
// В проде здесь подключается Яндекс.Почта для домена через обычный SMTP.
export async function sendLoginCode(email, code) {
  console.log(`[mailer:stub] login code for ${email}: ${code}`);
}
