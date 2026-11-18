export function escapeHtml(str) {
    if (str === null || str === undefined) return "";
    return String(str)
        .replace(/&/g, "&amp;")
        .replace(/</g, "&lt;")
        .replace(/>/g, "&gt;")
        .replace(/"/g, "&quot;")
        .replace(/'/g, "&#039;");
}

export function maskTgId(id) {
    const s = String(id || "");
    return s.length <= 4 ? s : `${s.slice(0, 2)}***${s.slice(-2)}`;
}

export function rubToKopecks(rub) {
    const num = parseFloat(String(rub).replace(",", "."));
    if (!Number.isFinite(num) || num < 0) return NaN;
    return Math.round(num * 100);
}

export function formatMoney(kopecks) {
    const val = (Number(kopecks) || 0) / 100;
    return Number.isInteger(val) ? `${val}` : val.toFixed(2);
}

export function getTimestampMs(createdAt) {
    if (!createdAt) return Date.now();
    if (typeof createdAt.toMillis === "function") return createdAt.toMillis();
    if (typeof createdAt === "number") return createdAt;
    return Date.now();
}

export function getCurrentMonthKey() {
    const now = new Date();
    return `${now.getFullYear()}-${String(now.getMonth() + 1).padStart(2, "0")}`;
}