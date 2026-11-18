import { DEFAULT_TARIFFS } from "./config.js";

/**
 * Единый расчет финансовых показателей по нормализованной схеме
 * (игнорирует отменённые операции status === 'cancelled')
 */
export function calculateMetrics(allApprovedEvents, pendingPayments, monthEvents, currentUserId = null) {
    let totalBoxesCountAll = 0;
    let totalBoxesBilledKopecks = 0;
    let approvedPaymentsKopecks = 0;
    let pendingPaymentsKopecks = 0;

    let totalAllCouriersEarnedKopecks = 0;
    let totalAllCouriersPaidKopecks = 0;

    let myEarnedAllKopecks = 0;
    let myPaidAllKopecks = 0;

    // 1. Расчет глобальных балансов по утвержденным операциям
    for (const e of allApprovedEvents) {
        if (e.status !== "approved") continue;

        if (e.type === "boxes") {
            const ffRate = e.tariffSnapshot?.boxFulfillmentPriceKopecks ?? DEFAULT_TARIFFS.boxFulfillmentPriceKopecks;
            const cRate = e.tariffSnapshot?.boxCourierPayKopecks ?? DEFAULT_TARIFFS.boxCourierPayKopecks;
            totalBoxesCountAll += e.count;
            totalBoxesBilledKopecks += e.count * ffRate;
            totalAllCouriersEarnedKopecks += e.count * cRate;

            if (currentUserId && e.courierId === currentUserId) {
                myEarnedAllKopecks += e.count * cRate;
            }
        } else if (e.type === "items" && e.courierId) {
            const cRate = e.tariffSnapshot?.itemCourierPayKopecks ?? DEFAULT_TARIFFS.itemCourierPayKopecks;
            totalAllCouriersEarnedKopecks += e.count * cRate;

            if (currentUserId && e.courierId === currentUserId) {
                myEarnedAllKopecks += e.count * cRate;
            }
        } else if (e.type === "payment") {
            approvedPaymentsKopecks += e.amountKopecks || 0;
        } else if (e.type === "payout") {
            totalAllCouriersPaidKopecks += e.amountKopecks || 0;
            if (currentUserId && e.courierId === currentUserId) {
                myPaidAllKopecks += e.amountKopecks || 0;
            }
        }
    }

    for (const p of pendingPayments) {
        if (p.type === "payment" && p.status === "pending") {
            pendingPaymentsKopecks += p.amountKopecks || 0;
        }
    }

    // 2. Расчет показателей за выбранный месяц
    let monthOzonRevenueKopecks = 0;
    let monthFulfillmentBoxesKopecks = 0;
    let monthCourierPayKopecks = 0;
    let myMonthItemsEarnKopecks = 0;
    let myMonthBoxesEarnKopecks = 0;

    for (const e of monthEvents) {
        if (e.status !== "approved") continue;

        if (e.type === "items" && e.courierId) {
            const ozonRate = e.tariffSnapshot?.itemOzonRevenueKopecks ?? DEFAULT_TARIFFS.itemOzonRevenueKopecks;
            const cRate = e.tariffSnapshot?.itemCourierPayKopecks ?? DEFAULT_TARIFFS.itemCourierPayKopecks;
            monthOzonRevenueKopecks += e.count * ozonRate;
            monthCourierPayKopecks += e.count * cRate;

            if (currentUserId && e.courierId === currentUserId) {
                myMonthItemsEarnKopecks += e.count * cRate;
            }
        } else if (e.type === "boxes") {
            const ffRate = e.tariffSnapshot?.boxFulfillmentPriceKopecks ?? DEFAULT_TARIFFS.boxFulfillmentPriceKopecks;
            const cRate = e.tariffSnapshot?.boxCourierPayKopecks ?? DEFAULT_TARIFFS.boxCourierPayKopecks;
            monthFulfillmentBoxesKopecks += e.count * ffRate;
            monthCourierPayKopecks += e.count * cRate;

            if (currentUserId && e.courierId === currentUserId) {
                myMonthBoxesEarnKopecks += e.count * cRate;
            }
        }
    }

    return {
        totalBoxesCountAll,
        fulfillmentDebtKopecks: Math.max(0, totalBoxesBilledKopecks - approvedPaymentsKopecks),
        pendingPaymentsKopecks,
        totalCourierDebtKopecks: Math.max(0, totalAllCouriersEarnedKopecks - totalAllCouriersPaidKopecks),
        myBalanceKopecks: Math.max(0, myEarnedAllKopecks - myPaidAllKopecks),
        monthOzonRevenueKopecks,
        monthCourierPayKopecks,
        monthOperatingMarginKopecks: (monthOzonRevenueKopecks + monthFulfillmentBoxesKopecks) - monthCourierPayKopecks,
        myMonthItemsEarnKopecks,
        myMonthBoxesEarnKopecks,
        myMonthTotalEarnKopecks: myMonthItemsEarnKopecks + myMonthBoxesEarnKopecks
    };
}