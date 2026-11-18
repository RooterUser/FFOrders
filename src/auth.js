import { signInWithCustomToken, signInAnonymously } from "https://www.gstatic.com/firebasejs/11.6.1/firebase-auth.js";
import { httpsCallable } from "https://www.gstatic.com/firebasejs/11.6.1/firebase-functions.js";
import { auth, functions, IS_LOCAL_PREVIEW } from "./config.js";

export async function authenticateUser() {
    const tg = window.Telegram?.WebApp;
    if (tg) {
        tg.ready();
        tg.expand();
    }

    const initData = tg?.initData;

    // 1. Боевая авторизация через серверную проверку криптографической подписи Telegram
    if (initData) {
        const authFn = httpsCallable(functions, "authenticateTelegram");
        const result = await authFn({ initData });
        const { token, user } = result.data;
        await signInWithCustomToken(auth, token);
        return user;
    }

    // 2. Локальный предпросмотр (работает исключительно на localhost)
    if (IS_LOCAL_PREVIEW) {
        await signInAnonymously(auth);
        return {
            id: "owner_6250414521",
            role: "owner",
            name: "Богдан (Local Preview)",
            tg_id: "6250414521",
            tg_username: "ddr712"
        };
    }

    throw new Error("NO_TELEGRAM_CONTEXT");
}