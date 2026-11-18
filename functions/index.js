const { onCall, HttpsError } = require("firebase-functions/v2/https");
const { defineSecret } = require("firebase-functions/params");
const admin = require("firebase-admin");
const crypto = require("crypto");

admin.initializeApp();
const db = admin.firestore();

// Секрет с токеном Telegram-бота (задается через: firebase functions:secrets:set BOT_TOKEN)
const botTokenSecret = defineSecret("BOT_TOKEN");
const MASTER_ADMIN_TG_ID = "6250414521";

/**
 * Криптографическая проверка подписи Telegram WebApp initData
 */
function verifyTelegramInitData(initData, botToken) {
    if (!initData || typeof initData !== "string") return null;
    const urlParams = new URLSearchParams(initData);
    const hash = urlParams.get("hash");
    if (!hash) return null;

    urlParams.delete("hash");
    const dataCheckArr = [];
    for (const [key, value] of urlParams.entries()) {
        dataCheckArr.push(`${key}=${value}`);
    }
    dataCheckArr.sort();
    const dataCheckString = dataCheckArr.join("\n");

    const secretKey = crypto.createHmac("sha256", "WebAppData").update(botToken).digest();
    const calculatedHash = crypto.createHmac("sha256", secretKey).update(dataCheckString).digest("hex");

    if (calculatedHash !== hash) return null;

    // Проверка свежести подписи (не старше 24 часов)
    const authDate = Number(urlParams.get("auth_date") || 0);
    if (Math.floor(Date.now() / 1000) - authDate > 86400) return null;

    const userJson = urlParams.get("user");
    return userJson ? JSON.parse(userJson) : null;
}

/**
 * 1. Авторизация: проверяет initData и выдает Firebase Custom Token с ролью
 */
exports.authenticateTelegram = onCall({ secrets: [botTokenSecret], cors: true }, async (request) => {
    const { initData } = request.data || {};
    const tgUser = verifyTelegramInitData(initData, botTokenSecret.value());

    if (!tgUser || !tgUser.id) {
        throw new HttpsError("unauthenticated", "Недействительная подпись Telegram.");
    }

    const tgId = String(tgUser.id);
    const usersSnap = await db.collection("users_registry").where("tg_id", "==", tgId).limit(1).get();

    let userDocId = null;
    let userData = null;

    if (!usersSnap.empty) {
        userDocId = usersSnap.docs[0].id;
        userData = usersSnap.docs[0].data();
    } else if (tgId === MASTER_ADMIN_TG_ID) {
        // Автоматическое создание корневого владельца при первом запуске
        userDocId = `owner_${MASTER_ADMIN_TG_ID}`;
        userData = {
            role: "owner",
            name: tgUser.first_name || "Богдан",
            tg_id: MASTER_ADMIN_TG_ID,
            tg_username: tgUser.username || "ddr712",
            createdAt: admin.firestore.FieldValue.serverTimestamp()
        };
        await db.collection("users_registry").doc(userDocId).set(userData);
    } else {
        throw new HttpsError("permission-denied", `Telegram ID ${tgId} не зарегистрирован в системе.`);
    }

    // Выпускаем токен Firebase с защищенными claims (их невозможно подделать на клиенте)
    const customToken = await admin.auth().createCustomToken(userDocId, {
        role: userData.role,
        tg_id: tgId,
        userDocId: userDocId
    });

    return {
        token: customToken,
        user: { id: userDocId, ...userData }
    };
});

/**
 * 2. Атомарное создание оплаты долга фулфилментом (защита от переплаты в гонке)
 */
exports.submitFulfillmentPayment = onCall({ cors: true }, async (request) => {
    if (!request.auth || request.auth.token.role !== "fulfillment") {
        throw new HttpsError("permission-denied", "Доступно только для роли Фулфилмент.");
    }

    const amountKopecks = Number(request.data?.amountKopecks);
    if (!Number.isInteger(amountKopecks) || amountKopecks <= 0) {
        throw new HttpsError("invalid-argument", "Некорректная сумма в копейках.");
    }

    const authorId = request.auth.token.userDocId;

    return await db.runTransaction(async (tx) => {
        const boxesSnap = await tx.get(
            db.collection("events").where("type", "==", "boxes").where("status", "==", "approved")
        );
        const paymentsSnap = await tx.get(
            db.collection("events").where("type", "==", "payment").where("status", "in", ["approved", "pending"])
        );

        let totalBilled = 0;
        boxesSnap.forEach((doc) => {
            const d = doc.data();
            const rate = d.tariffSnapshot?.boxFulfillmentPriceKopecks ?? 4500;
            totalBilled += d.count * rate;
        });

        let totalPaidOrPending = 0;
        paymentsSnap.forEach((doc) => {
            totalPaidOrPending += doc.data().amountKopecks || 0;
        });

        const maxAllowed = totalBilled - totalPaidOrPending;
        if (maxAllowed <= 0 || amountKopecks > maxAllowed) {
            throw new HttpsError("failed-precondition", `Сумма превышает доступный остаток долга (${(maxAllowed / 100).toFixed(2)} ₽).`);
        }

        const newRef = db.collection("events").doc();
        tx.set(newRef, {
            type: "payment",
            amountKopecks,
            status: "pending",
            authorId,
            createdAt: admin.firestore.FieldValue.serverTimestamp(),
            monthKey: new Date().toISOString().slice(0, 7),
            auditLog: [{ action: "created", by: authorId, at: Date.now() }]
        });

        return { id: newRef.id };
    });
});

/**
 * 3. Атомарное списание выплаты курьеру владельцем (защита от отрицательного долга)
 */
exports.submitCourierPayout = onCall({ cors: true }, async (request) => {
    if (!request.auth || request.auth.token.role !== "owner") {
        throw new HttpsError("permission-denied", "Доступно только владельцу.");
    }

    const { courierId } = request.data || {};
    const amountKopecks = Number(request.data?.amountKopecks);
    if (!courierId || !Number.isInteger(amountKopecks) || amountKopecks <= 0) {
        throw new HttpsError("invalid-argument", "Некорректные параметры выплаты.");
    }

    const ownerId = request.auth.token.userDocId;

    return await db.runTransaction(async (tx) => {
        const boxesSnap = await tx.get(
            db.collection("events").where("type", "==", "boxes").where("courierId", "==", courierId).where("status", "==", "approved")
        );
        const itemsSnap = await tx.get(
            db.collection("events").where("type", "==", "items").where("courierId", "==", courierId).where("status", "==", "approved")
        );
        const payoutsSnap = await tx.get(
            db.collection("events").where("type", "==", "payout").where("courierId", "==", courierId).where("status", "==", "approved")
        );

        let totalEarned = 0;
        boxesSnap.forEach((doc) => {
            const d = doc.data();
            totalEarned += d.count * (d.tariffSnapshot?.boxCourierPayKopecks ?? 3000);
        });
        itemsSnap.forEach((doc) => {
            const d = doc.data();
            totalEarned += d.count * (d.tariffSnapshot?.itemCourierPayKopecks ?? 200);
        });

        let totalPaid = 0;
        payoutsSnap.forEach((doc) => {
            totalPaid += doc.data().amountKopecks || 0;
        });

        const available = totalEarned - totalPaid;
        if (available <= 0 || amountKopecks > available) {
            throw new HttpsError("failed-precondition", `Доступно к выплате курьеру: ${(available / 100).toFixed(2)} ₽.`);
        }

        const newRef = db.collection("events").doc();
        tx.set(newRef, {
            type: "payout",
            courierId,
            amountKopecks,
            status: "approved",
            authorId: ownerId,
            createdAt: admin.firestore.FieldValue.serverTimestamp(),
            monthKey: new Date().toISOString().slice(0, 7),
            auditLog: [{ action: "payout_issued", by: ownerId, at: Date.now() }]
        });

        return { id: newRef.id };
    });
});