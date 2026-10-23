// Local, advisory estimate only. No password is sent or stored, and this
// function is never used to decide whether certificate creation is allowed.
export function passwordStrengthHint(password) {
  if (!password) return "未设置密码：备份不加密。";
  const length = Array.from(password).length;
  const unique = new Set(password).size;
  const simple = /^(\s+|(.{1,4})\2+)$/u.test(password) ||
    /^(password|qwerty|1234567890|0123456789|9876543210|abcdefghijklmnopqrstuvwxyz)/i.test(password);
  const strength = simple || length < 10 || unique < 5
    ? "弱"
    : length >= 16 && unique >= 8 ? "较强" : "一般";
  return `密码强度：${strength}。`;
}
