import {
    collection, doc, addDoc, setDoc, onSnapshot, runTransaction,
    query, where, orderBy, limit, startAfter, getDocs, serverTimestamp, arrayUnion
} from "https://www.gstatic.com/firebasejs/11.6.1/firebase-firestore.js";
import { httpsCallable } from "https://www.gstatic.com/firebasejs/11.6.1/firebase-functions.js";
import { db, functions, DEFAULT_TARIFFS } from "./config.js";
import { getCurrentMonthKey } from "./formatters.js";

export function subscribeTariffs(onUpdate, onError) {
    return onSnapshot(doc(db, "settings", "tariffs"), (snap) => {
        onUpdate(snap.exists() ? { ...DEFAULT_TARIFFS, ...snap.data() } : { ...DEFAULT_TARIFFS });
    }, onError);
}

export function subscribeUsers(onUpdate, onError) {
    return onSnapshot(collection(db, "users_registry"), (snap) => {
        const map = {};
        snap.forEach((d) => { map[d.id] = { id: d.id, ...d.data() }; });
        onUpdate(map);
    }, onError);
}

// Подписка только на незавершенные/активные заявки (не тянет всю базу)
export function subscribePendingEvents(onUpdate, onError) {
    const q = query(collection(db, "events"), where("status", "==", "pending"), orderBy("createdAt", "desc"), limit(100));
    return onSnapshot(q, (snap) => {
        const list = [];
        snap.forEach((d) => list.push({ id: d.id, ...d.data() }));
        onUpdate(list);
    }, onError);
}

// Подписка на утвержденные операции для расчета актуальных балансов
export function subscribeApprovedBalances(onUpdate, onError) {
    const q = query(collection(db, "events"), where("status", "==", "approved"));
    return onSnapshot(q, (snap) => {
        const list = [];
        snap.forEach((d) => list.push({ id: d.id, ...d.data() }));
        onUpdate(list);
    }, onError);
}

// Курсорная пагинация истории за конкретный месяц (по 25 записей)
export async function fetchMonthHistoryPage(monthKey, lastDocCursor = null, pageSize = 25) {
    let q = query(
        collection(db, "events"),
        where("monthKey", "==", monthKey),
        orderBy("createdAt", "desc"),
        limit(pageSize)
    );
    if (lastDocCursor) {
        q = query(
            collection(db, "events"),
            where("monthKey", "==", monthKey),
            orderBy("createdAt", "desc"),
            startAfter(lastDocCursor),
            limit(pageSize)
        );
    }
    const snap = await getDocs(q);
    const items = [];
    snap.forEach((d) => items.push({ id: d.id, ...d.data() }));
    const nextCursor = snap.docs.length === pageSize ? snap.docs[snap.docs.length - 1] : null;
    return { items, nextCursor };
}

export async function createItemsTask(count, authorId, tariffs) {
    return addDoc(collection(db, "events"), {
        type: "items",
        count,
        courierId: null,
        authorId,
        status: "pending",
        createdAt: serverTimestamp(),
        monthKey: getCurrentMonthKey(),
        tariffSnapshot: {
            itemCourierPayKopecks: tariffs.itemCourierPayKopecks,
            itemOzonRevenueKopecks: tariffs.itemOzonRevenueKopecks
        },
        auditLog: [{ action: "created", by: authorId, at: Date.now() }]
    });
}

export async function createBoxesSubmission(count, courierId, tariffs) {
    return addDoc(collection(db, "events"), {
        type: "boxes",
        count,
        courierId, // Явный идентификатор курьера
        authorId: courierId,
        status: "pending",
        createdAt: serverTimestamp(),
        monthKey: getCurrentMonthKey(),
        tariffSnapshot: {
            boxCourierPayKopecks: tariffs.boxCourierPayKopecks,
            boxFulfillmentPriceKopecks: tariffs.boxFulfillmentPriceKopecks
        },
        auditLog: [{ action: "submitted", by: courierId, at: Date.now() }]
    });
}

// Атомарное принятие задания курьером
export async function claimTaskTx(taskId, courierId) {
    const ref = doc(db, "events", taskId);
    return runTransaction(db, async (tx) => {
        const snap = await tx.get(ref);
        if (!snap.exists()) throw new Error("Задание не найдено");
        const d = snap.data();
        if (d.status !== "pending" || d.courierId !== null) {
            throw new Error("Задание уже забрал другой курьер или оно отменено");
        }
        tx.update(ref, {
            courierId,
            status: "approved",
            claimedAt: serverTimestamp(),
            auditLog: arrayUnion({ action: "claimed", by: courierId, at: Date.now() })
        });
    });
}

// Атомарное подтверждение (коробок фулфилментом или оплаты владельцем)
export async function approvePendingTx(eventId, actorId, expectedType) {
    const ref = doc(db, "events", eventId);
    return runTransaction(db, async (tx) => {
        const snap = await tx.get(ref);
        if (!snap.exists()) throw new Error("Запись не найдена");
        const d = snap.data();
        if (d.type !== expectedType || d.status !== "pending") {
            throw new Error("Операция уже была обработана");
        }
        tx.update(ref, {
            status: "approved",
            approvedBy: actorId,
            approvedAt: serverTimestamp(),
            auditLog: arrayUnion({ action: "approved", by: actorId, at: Date.now() })
        });
    });
}

// Мягкая отмена (перевод в статус cancelled с записью в аудит вместо удаления)
export async function cancelPendingTx(eventId, actorId) {
    const ref = doc(db, "events", eventId);
    return runTransaction(db, async (tx) => {
        const snap = await tx.get(ref);
        if (!snap.exists()) throw new Error("Запись не найдена");
        const d = snap.data();
        if (d.status !== "pending") {
            throw new Error("Нельзя отменить уже подтвержденную операцию");
        }
        tx.update(ref, {
            status: "cancelled",
            cancelledBy: actorId,
            cancelledAt: serverTimestamp(),
            auditLog: arrayUnion({ action: "cancelled", by: actorId, at: Date.now() })
        });
    });
}

// Вызов серверных транзакций с проверкой баланса
export async function callSubmitPayment(amountKopecks) {
    const fn = httpsCallable(functions, "submitFulfillmentPayment");
    return fn({ amountKopecks });
}

export async function callSubmitPayout(courierId, amountKopecks) {
    const fn = httpsCallable(functions, "submitCourierPayout");
    return fn({ courierId, amountKopecks });
}

export async function saveTariffsDoc(newTariffs, ownerId) {
    return setDoc(doc(db, "settings", "tariffs"), {
        ...newTariffs,
        updatedBy: ownerId,
        updatedAt: serverTimestamp()
    });
}

export async function addUserDoc(userObj, ownerId) {
    return setDoc(doc(db, "users_registry", `user_${userObj.tg_id}`), {
        ...userObj,
        createdBy: ownerId,
        createdAt: serverTimestamp()
    });
}