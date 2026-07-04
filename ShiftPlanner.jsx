import { useState, useCallback } from "react";

const SHIFTS = {
  早: { label: "早番", short: "早", color: "#F59E0B", bg: "#FEF3C7", text: "#92400E" },
  日: { label: "日勤", short: "日", color: "#3B82F6", bg: "#DBEAFE", text: "#1E3A8A" },
  遅: { label: "遅番", short: "遅", color: "#8B5CF6", bg: "#EDE9FE", text: "#4C1D95" },
  休: { label: "休　み", short: "休", color: "#6B7280", bg: "#F3F4F6", text: "#374151" },
  有: { label: "有　給", short: "有", color: "#10B981", bg: "#D1FAE5", text: "#065F46" },
  待: { label: "待　機", short: "待", color: "#0EA5E9", bg: "#E0F2FE", text: "#0C4A6E" },
};

// 休みルール（スタッフ個別設定）
const DEFAULT_OFFDAYS = 10; // デフォルト月間「休み」目標回数
const REST_TYPES = ["休", "待"]; // 選択可能な休みタイプ

// スタッフオブジェクトから休みルールを返す
function getRestRule(staff) {
  return { restType: staff.restType || "休", target: staff.restTarget ?? DEFAULT_OFFDAYS };
}

// 人員過多（2人以上）アラート
const EXCESS_BG     = "#FFF7ED";
const EXCESS_BORDER = "#F97316";
const EXCESS_HDR    = "#FFEDD5";
// 人員不足（0人）アラート
const SHORTAGE_BG     = "#FFF0F0";
const SHORTAGE_BORDER = "#ef4444";
const SHORTAGE_HDR    = "#fee2e2";

// 目標: 各シフト1人（1人以上2人未満 = ちょうど1人）
const TARGET_PER_SHIFT = 1;
const DAYS_OF_WEEK = ["日","月","火","水","木","金","土"];

function getDaysInMonth(y, m) { return new Date(y, m, 0).getDate(); }

// ============================================================
// シフト自動生成
//
// 目標: 早番・遅番を毎日1人必須確保（最優先）
//       日勤は0人以上可（余剰スタッフをSTEP3で充当）
//       遅番連続可（遅→遅→休み など）、遅番翌日に早番・日勤は不可
//
// 公平性ルール:
//   ・スタッフ間で「早番の回数」「日勤の回数」「遅番の回数」が
//     それぞれできるだけ均等になるように割り当てる
//     （毎日の担当者は、その時点までの担当回数が少ない人を優先）
//
// 休みルール:
//   ・各スタッフの「休み」目標回数（合計）は個別に設定可（デフォルト10回）
//   ・「有給」は自動生成では使用しない。希望入力タブから手動で
//     入力した場合のみシフト表に反映される
//   ・「有給」は休みとして実績にカウントする（休み目標の達成判定や
//     連勤日数の計算にも、休みと同様に扱う）
//   ・1日あたりの「休み（休＋有）」人数は、なるべく2人までに収める
//     （目標休み日数の達成が必要な場合は2人を超えることも許容する
//     ソフトな制約）
//   ・最終工程（STEP4.7）で、早番・遅番のカバレッジを一切崩さずに
//     「日勤」との入れ替えのみで休み合計を指定回数ぴったりに合わせる
//     （手動希望が入っている日・遅番翌日の必須休みは変更しない。
//     日勤側の残り日数が足りない等で不可能な場合のみ差分が残る）
//
// ルール:
//   ① 希望シフト優先（有給を手動指定した場合もここで反映）
//   ② 遅番の翌日は必ず「休み」（翌日も遅番継続の場合は除く）
//   ③ 5連続出勤なし（有給も休みとして連勤カウントをリセットする）
//   ④ 3連続同一シフト回避（早早・日日・遅遅の2連続は許容）
//   ⑤ 早番・遅番は各1人を絶対確保（日勤スタッフ振替・連続制約無視も辞さない。
//     後続工程で崩れた場合も最終パス（STEP4.6）で再確保する）
//   ⑥ 早番・遅番が0人 → 不足として赤で可視化（日勤は0人でも不足扱いしない）
//   ⑦ 早番・遅番が2人以上 → 過多としてオレンジで可視化
//   ⑧ 早番・日勤・遅番の必須人数を満たした上での余剰人員は日勤に割り当て
//   ⑨ 各スタッフの「休み」日数（設定タイプ＋有給＋待機）を指定された
//     目標回数ちょうどに合わせる（STEP4.7で最終調整）
//   ⑩ 1日の休み人数（休＋有）はなるべく2人までに抑える
// ============================================================
function generateOnce(staffList, year, month, preferences) {
  const daysInMonth = getDaysInMonth(year, month);

  const sch = {};
  staffList.forEach(s => { sch[s.id] = Array(daysInMonth).fill(null); });

  // スタッフ個別の休みルール（restType: 休 or 待、target: 目標回数）
  const restRuleOf = {};
  staffList.forEach(staff => { restRuleOf[staff.id] = getRestRule(staff); });
  // 「有給」「待機」も休みとして扱う（連勤カウントや休み実績にも休みとして算入する）
  // 休み・有給・待機すべて「非勤務扱い」として連勤カウントと休み実績に算入
  const isRestShift = (shift, staffId) => shift === restRuleOf[staffId].restType || shift === "有" || shift === "待";
  // ある1日に「休み」状態（休 または 有）のスタッフが何人いるかを数える
  // 待機も含めて「休み扱い」のスタッフ数を数える
  const restCountOnDay = d => staffList.filter(st => {
    const v = sch[st.id][d];
    return v !== null && v !== undefined && isRestShift(v, st.id);
  }).length;
  // その日の休み人数が上限(2人)未満かどうか
  const MAX_REST_PER_DAY = 2;

  // 各スタッフのシフト別カウント（公平な割り当てに使用）
  const shiftCount = {};
  staffList.forEach(staff => { shiftCount[staff.id] = { 早: 0, 日: 0, 遅: 0 }; });

  // ---- STEP 1: 希望シフトを先に反映 ----
  staffList.forEach(staff => {
    const prefs = preferences[staff.id] || {};
    const s = sch[staff.id];
    const myRest = restRuleOf[staff.id].restType;
    for (let d = 0; d < daysInMonth; d++) {
      if (prefs[d + 1]) s[d] = prefs[d + 1];
    }
    // 遅番希望の翌日を強制的にそのスタッフの休み種別に
    for (let d = 0; d < daysInMonth - 1; d++) {
      if (s[d] === "遅" && s[d + 1] === null) s[d + 1] = myRest;
    }
  });

  // 希望反映分を先にカウントしておく（公平性の基準点に含める）
  staffList.forEach(staff => {
    const s = sch[staff.id];
    s.forEach(v => { if (v === "早" || v === "日" || v === "遅") shiftCount[staff.id][v]++; });
  });

  // ---- STEP 2: 早番・遅番を確保する（日勤はSTEP3で余り充当）----
  //   優先順位: 早番 = 遅番 > 日勤（日勤は0人でも可）
  //   遅番連続可（遅→遅→休み など）
  //   遅番翌日に早番・日勤は不可。遅番は連続可。
  for (let d = 0; d < daysInMonth; d++) {
    for (const target of ["早", "遅"]) {
      const already = () => staffList.filter(st => sch[st.id][d] === target).length;
      if (already() >= TARGET_PER_SHIFT) continue;

      const candidates = [...staffList].sort((a, b) => {
        const diff = shiftCount[a.id][target] - shiftCount[b.id][target];
        if (diff !== 0) return diff;
        return Math.random() - 0.5;
      });

      for (const staff of candidates) {
        if (already() >= TARGET_PER_SHIFT) break;
        const prefs = preferences[staff.id] || {};
        const s = sch[staff.id];

        if (s[d] !== null) continue; // 既に確定済み

        // 遅番の翌日: 遅番は連続可、早番は不可
        if (d > 0 && s[d - 1] === "遅" && target !== "遅") continue;

        // 4連続勤務まで可（5連続禁止）
        let before = 0;
        for (let b = d - 1; b >= 0 && s[b] !== null && !isRestShift(s[b], staff.id); b--) before++;
        if (before >= 4) continue;

        // 早番のみ3連続回避（遅番は連続可）
        if (target === "早" && d >= 2 && s[d - 1] === "早" && s[d - 2] === "早") continue;

        if (target === "遅") {
          const np = prefs[d + 2]; // 翌日の希望（1-indexed → d+2）
          // 翌日に早番・日勤希望があれば遅番不可（遅番希望・休み希望・未設定はOK）
          if (np && np !== "休" && np !== "有" && np !== "遅" && np !== "待") continue;
          s[d] = target;
          shiftCount[staff.id][target]++;
          // 翌日が遅番希望でなく未設定なら、STEP3で強制休みになる（pre-assign不要）
        } else {
          s[d] = target;
          shiftCount[staff.id][target]++;
        }
      }
    }
  }

  // ---- STEP 2.5: 早番・遅番の絶対確保パス（フォールバック）-----------------
  // STEP2で確保できなかった日を修正。希望日勤→強制振替、それもなければnullから強制。
  // 遅番連続は許容。翌日のpre-assignはしない（STEP3の強制休みルールに任せる）。
  for (let d = 0; d < daysInMonth; d++) {
    for (const must of ["早", "遅"]) {
      const covered = staffList.filter(st => sch[st.id][d] === must).length;
      if (covered >= 1) continue;

      // ① 希望なしの日勤（preference由来）スタッフを振り替え
      const dayWorkers = staffList
        .filter(st => sch[st.id][d] === "日" && !(preferences[st.id]?.[d + 1]))
        .sort((a, b) => shiftCount[a.id][must] - shiftCount[b.id][must]);

      if (dayWorkers.length > 0) {
        const c = dayWorkers[0];
        shiftCount[c.id]["日"] = Math.max((shiftCount[c.id]["日"] || 0) - 1, 0);
        sch[c.id][d] = must;
        shiftCount[c.id][must] = (shiftCount[c.id][must] || 0) + 1;
        continue;
      }

      // ② nullスロットから連続制約を無視して強制割り当て
      const nullWorkers = staffList
        .filter(st => sch[st.id][d] === null)
        .sort((a, b) => shiftCount[a.id][must] - shiftCount[b.id][must]);

      if (nullWorkers.length > 0) {
        const c = nullWorkers[0];
        sch[c.id][d] = must;
        shiftCount[c.id][must] = (shiftCount[c.id][must] || 0) + 1;
      }
    }
  }

  // ---- STEP 3: 残り(null)を埋める。休み目標回数を考慮しつつ、
  //              日勤は担当回数が少ない人を優先しつつ全員に配分 ----
  // 何度かパスを回して「null かつ休み確定でない日」を、
  // 日勤カウントが少ないスタッフから順に埋めていく
  let safetyCounter = 0;
  while (safetyCounter < daysInMonth * staffList.length + 10) {
    safetyCounter++;

    // まず強制条件（前日遅番／4連続勤務済み）を全スタッフ・全日で適用
    let appliedForce = false;
    staffList.forEach(staff => {
      const s = sch[staff.id];
      const { restType } = restRuleOf[staff.id];
      let consec = 0;
      for (let d = 0; d < daysInMonth; d++) {
        if (s[d] === null) {
          if (d > 0 && s[d - 1] === "遅") { s[d] = restType; appliedForce = true; continue; }
          // 直近の連続勤務数を数える（nullマスより前の連続勤務日数）
          let runningConsec = 0;
          for (let b = d - 1; b >= 0 && s[b] !== null && !isRestShift(s[b], staff.id); b--) runningConsec++;
          // すでに4日連続勤務 → この日(null)を休みに強制（5連続を防ぐ）
          if (runningConsec >= 4) { s[d] = restType; appliedForce = true; continue; }
        }
      }
    });

    // 残りnullがなければ終了
    const hasNull = staffList.some(staff => sch[staff.id].includes(null));
    if (!hasNull) break;

    // 日勤担当回数が最も少ないスタッフを選び、そのスタッフの最初のnull日を日勤候補にする
    // ただし休み目標未達なら休みを優先
    const candidateStaffs = [...staffList].sort((a, b) => {
      const diff = shiftCount[a.id]["日"] - shiftCount[b.id]["日"];
      if (diff !== 0) return diff;
      return Math.random() - 0.5;
    });

    let progressed = false;
    for (const staff of candidateStaffs) {
      const s = sch[staff.id];
      const { restType, target } = restRuleOf[staff.id];
      const nullIdx = s.findIndex(v => v === null);
      if (nullIdx === -1) continue;

      const d = nullIdx;
      // 「有給」も休みとして実績にカウントする
      const restCount = s.filter(v => isRestShift(v, staff.id)).length;
      const remainingNulls = s.filter(v => v === null).length;
      const stillNeeded = Math.max(target - restCount, 0);

      // 3連続日勤回避
      const wouldBeThirdConsecDay = (d >= 2 && s[d - 1] === "日" && s[d - 2] === "日");
      // 休み目標が残りマス数に対して逼迫しているか（これは必達なので上限を超えても優先）
      const mustRestNow = stillNeeded > 0 && stillNeeded >= remainingNulls;
      // その日すでに休み（休＋有）が2人に達しているか（なるべく超えないようにする＝ソフト制約）
      const dayRestFull = restCountOnDay(d) >= MAX_REST_PER_DAY;

      if (mustRestNow || wouldBeThirdConsecDay) {
        s[d] = restType;
      } else if (stillNeeded > 0 && !dayRestFull && Math.random() < (stillNeeded / Math.max(remainingNulls, 1)) * 0.85) {
        s[d] = restType;
      } else {
        s[d] = "日";
        shiftCount[staff.id]["日"]++;
      }
      progressed = true;
      break; // 1回のループで1マスだけ確定し、再度カウントの少ない人から選び直す
    }
    if (!progressed) break;
  }

  // 念のための最終nullクリンナップ（理論上は発生しないが安全策）
  staffList.forEach(staff => {
    const s = sch[staff.id];
    const { restType } = restRuleOf[staff.id];
    for (let d = 0; d < daysInMonth; d++) {
      if (s[d] === null) s[d] = restType;
    }
  });

  // 遅番後の最終確認（手動希望以外）
  // ※ 翌日も「遅番継続」の場合は上書きしない（遅番連続は許容ルールのため）
  staffList.forEach(staff => {
    const prefs = preferences[staff.id] || {};
    const s = sch[staff.id];
    const { restType } = restRuleOf[staff.id];
    for (let d = 0; d < daysInMonth - 1; d++) {
      if (s[d] === "遅" && s[d + 1] !== restType && s[d + 1] !== "遅" && !prefs[d + 2]) {
        s[d + 1] = restType;
      }
    }
  });

  // ---- STEP 4.5: 5連続勤務の安全チェック（遅番連続含む）----
  // 全工程が終わった後でもう一度スキャンし、5日以上連続していたら
  // 5日目を強制的に休みに変えて、前後のシフトを再調整する。
  // これにより、希望シフト入力で5連続が発生した場合でも確実にルールを守る。
  staffList.forEach(staff => {
    const s = sch[staff.id];
    const { restType } = restRuleOf[staff.id];
    for (let d = 0; d < daysInMonth; d++) {
      if (!isRestShift(s[d], staff.id)) {
        // d日目が勤務の場合、ここを起点に何日連続か数える
        let run = 0;
        let start = d;
        while (start < daysInMonth && !isRestShift(s[start], staff.id)) { run++; start++; }
        // 5日以上連続なら5日目（d+4）を強制休みにする
        if (run >= 5) {
          s[d + 4] = restType;
          d += 4; // 修正した日からスキャンを再開
        }
      }
    }
  });


  // ---- STEP 4.6: 早番・遅番の最終再保証パス -----------------------------
  // 「遅番後の最終確認」やSTEP4.5の5連続勤務チェックで、その日唯一の
  // 早番・遅番担当者が休みに変更されてしまうことがあるため、全工程の最後に
  // もう一度カバレッジを検査し、0人の日があれば代わりのスタッフ
  // （① 希望指定のない日勤 → ② 希望指定のない休み・待機・有給の順）を
  // 割り当てて必ず1人を確保する（連続勤務等の制約より優先＝ルール⑤）。
  for (let d = 0; d < daysInMonth; d++) {
    for (const must of ["早", "遅"]) {
      const covered = staffList.filter(st => sch[st.id][d] === must).length;
      if (covered >= 1) continue;

      const dayWorkers = staffList
        .filter(st => sch[st.id][d] === "日" && !(preferences[st.id]?.[d + 1]))
        .sort((a, b) => shiftCount[a.id][must] - shiftCount[b.id][must]);

      const restWorkers = staffList
        .filter(st => isRestShift(sch[st.id][d], st.id) && !(preferences[st.id]?.[d + 1]))
        .sort((a, b) => shiftCount[a.id][must] - shiftCount[b.id][must]);

      const candidate = dayWorkers[0] || restWorkers[0];
      if (candidate) {
        if (sch[candidate.id][d] === "日") {
          shiftCount[candidate.id]["日"] = Math.max((shiftCount[candidate.id]["日"] || 0) - 1, 0);
        }
        sch[candidate.id][d] = must;
        shiftCount[candidate.id][must] = (shiftCount[candidate.id][must] || 0) + 1;
      }
    }
  }

  // ---- STEP 4.7: 休み合計を指定回数ちょうどに合わせる最終調整パス ---------
  // ここまでの工程で早番・遅番のカバレッジは確定済み（このステップでは
  // 早番・遅番には一切手を付けない）。各スタッフの「休み合計
  // （休＋有＋待）」を個別に指定された目標回数ぴったりに近づけるため、
  // 「日勤」との入れ替えのみで調整する。
  //   ・休みが多すぎる → 「休」または「待」の日を日勤に変更（有給は手動入力
  //     のため変更しない。希望指定がある日・遅番翌日の必須休みも変更しない）
  //   ・休みが足りない → 「日勤」の日を、そのスタッフの休みタイプに変更
  //     （希望指定がある日は変更しない）
  // 5連続勤務が新たに発生する変更は行わない。
  staffList.forEach(staff => {
    const s = sch[staff.id];
    const prefs = preferences[staff.id] || {};
    const { restType, target } = restRuleOf[staff.id];
    const isLocked = d => prefs[d + 1] !== undefined;
    const isMandatoryRestDay = d => d > 0 && s[d - 1] === "遅"; // 遅番翌日は必須休み

    const actualRest = () => s.filter(v => isRestShift(v, staff.id)).length;
    let diff = actualRest() - target; // > 0: 休みが多すぎる／< 0: 休みが足りない

    if (diff > 0) {
      for (let d = 0; d < s.length && diff > 0; d++) {
        if ((s[d] !== "休" && s[d] !== "待") || isLocked(d) || isMandatoryRestDay(d)) continue;
        // 日勤に変えても5連続勤務にならないか確認
        let before = 0;
        for (let b = d - 1; b >= 0 && !isRestShift(s[b], staff.id); b--) before++;
        let after = 0;
        for (let a = d + 1; a < s.length && !isRestShift(s[a], staff.id); a++) after++;
        if (before + 1 + after >= 5) continue;
        s[d] = "日";
        shiftCount[staff.id]["日"] = (shiftCount[staff.id]["日"] || 0) + 1;
        diff--;
      }
    } else if (diff < 0) {
      let need = -diff;
      for (let d = 0; d < s.length && need > 0; d++) {
        if (s[d] !== "日" || isLocked(d)) continue;
        s[d] = restType;
        shiftCount[staff.id]["日"] = Math.max((shiftCount[staff.id]["日"] || 0) - 1, 0);
        need--;
      }
    }
  });

  // 早番・遅番: 0人なら不足、2人以上なら過多として可視化
  // 日勤: 0人でも良い（必須条件ではないため不足扱いしない）。人数上限もなし（過多警告なし）
  const flags = {};
  for (let d = 0; d < daysInMonth; d++) {
    flags[d] = {};
    for (const shift of ["早", "日", "遅"]) {
      const cnt = staffList.filter(st => sch[st.id][d] === shift).length;
      if (shift === "日") {
        flags[d][shift] = { type: "ok", cnt }; // 日勤は0人でも不足扱いしない
      } else if (cnt === 0) {
        flags[d][shift] = { type: "shortage", cnt };
      } else if (cnt >= TARGET_PER_SHIFT + 1) {
        flags[d][shift] = { type: "excess", cnt };
      } else {
        flags[d][shift] = { type: "ok", cnt };
      }
    }
  }

  // ---- STEP 5: 休み回数 & 公平性（早/日/遅の担当回数）の実績集計 ----
  // 最終的な配列から再集計（手動希望での上書きも反映するため）
  const finalCount = {};
  staffList.forEach(staff => {
    finalCount[staff.id] = { 早: 0, 日: 0, 遅: 0 };
    sch[staff.id].forEach(v => { if (v === "早" || v === "日" || v === "遅") finalCount[staff.id][v]++; });
  });
  const avgOf = shift => {
    const total = staffList.reduce((sum, st) => sum + finalCount[st.id][shift], 0);
    return staffList.length ? total / staffList.length : 0;
  };
  const fairnessAvg = { 早: avgOf("早"), 日: avgOf("日"), 遅: avgOf("遅") };

  const restSummary = {};
  staffList.forEach(staff => {
    const { restType, target } = restRuleOf[staff.id];
    const restOnlyCount = sch[staff.id].filter(v => v === restType).length;
    const manualPaidLeave = sch[staff.id].filter(v => v === "有").length;
    const standbyCount = sch[staff.id].filter(v => v === "待" && restType !== "待").length;
    // 「有給」「待機」は休みとしてカウントする（合計で目標達成を判定）
    const actual = restOnlyCount + manualPaidLeave + standbyCount;
    restSummary[staff.id] = {
      restType, target, actual, restOnlyCount, manualPaidLeave, standbyCount,
      counts: finalCount[staff.id],
    };
  });

  return { schedule: sch, flags, restSummary, fairnessAvg };
}

// ---- 複数回試行して「休み合計」の一致度が最も高い結果を採用する ----
// generateOnce の内部には Math.random() による揺らぎがあり、同じ入力でも
// 早番・遅番の割り当て順序や休みの配置が試行ごとに変わる。この揺らぎを
// 利用して何度か生成し直し、各スタッフの「休み実績」が目標にもっとも近い
// （かつ早番・遅番のカバレッジは常に確保された）結果を採用する。
// これは実質的に、スタッフ間で休みや日勤を組み替えた場合を幅広く
// 試した上で一番良い組み合わせを選ぶのと同じ効果になる。
const GENERATE_ATTEMPTS = 40;

function scoreRestMismatch(result, staffList) {
  let mismatch = 0;
  staffList.forEach(staff => {
    const rs = result.restSummary[staff.id];
    mismatch += Math.abs(rs.actual - rs.target);
  });
  return mismatch;
}

function generateShifts(staffList, year, month, preferences) {
  let best = null;
  let bestScore = Infinity;
  for (let attempt = 0; attempt < GENERATE_ATTEMPTS; attempt++) {
    const result = generateOnce(staffList, year, month, preferences);
    const score = scoreRestMismatch(result, staffList);
    if (score < bestScore) {
      best = result;
      bestScore = score;
      if (bestScore === 0) break; // 全スタッフが目標どおりになったら打ち切り
    }
  }
  return best;
}

// ---- スタッフ追加モーダル ----
function StaffModal({ onAdd, onClose }) {
  const [name, setName] = useState("");
  return (
    <div style={{ position:"fixed",inset:0,background:"rgba(0,0,0,0.5)",display:"flex",alignItems:"center",justifyContent:"center",zIndex:100 }}>
      <div style={{ background:"#fff",borderRadius:16,padding:32,minWidth:320,boxShadow:"0 20px 60px rgba(0,0,0,0.2)" }}>
        <h3 style={{ margin:"0 0 20px",fontSize:18,color:"#1e293b",fontWeight:700 }}>スタッフを追加</h3>
        <input autoFocus value={name} onChange={e=>setName(e.target.value)}
          onKeyDown={e=>{ if(e.key==="Enter"&&name.trim()) onAdd(name.trim()); }}
          placeholder="スタッフ名を入力"
          style={{ width:"100%",padding:"10px 14px",border:"2px solid #e2e8f0",borderRadius:8,fontSize:15,outline:"none",boxSizing:"border-box" }}
          onFocus={e=>e.target.style.borderColor="#3B82F6"}
          onBlur={e=>e.target.style.borderColor="#e2e8f0"}
        />
        <div style={{ display:"flex",gap:10,marginTop:20,justifyContent:"flex-end" }}>
          <button onClick={onClose} style={{ padding:"8px 20px",borderRadius:8,border:"2px solid #e2e8f0",background:"#fff",cursor:"pointer",fontSize:14,color:"#64748b" }}>キャンセル</button>
          <button onClick={()=>{ if(name.trim()) onAdd(name.trim()); }} style={{ padding:"8px 20px",borderRadius:8,border:"none",background:"#3B82F6",color:"#fff",cursor:"pointer",fontSize:14,fontWeight:600 }}>追加</button>
        </div>
      </div>
    </div>
  );
}


// ============================================================
// チーム間互助シフト計算
//
// 【絶対ルール】早番・遅番は各チームが自力で必ず確保する（互助対象外）。
// 【互助対象】日勤の人員不足のみ。相手チームの「休」「待機」スタッフで補完。
// ============================================================
function computeCrossSupport(resultA, staffA, resultB, staffB, year, month) {
  const daysInMonth = getDaysInMonth(year, month);
  // 【絶対ルール】早番・遅番は自チームで必ず確保。互助カバーは日勤のみ。
  const SHIFT_ORDER = ["日"];
  // supportForA[d] = [{staffId, staffName, shift}]  ← Bチームがサポート
  // supportForB[d] = [{staffId, staffName, shift}]  ← Aチームがサポート
  const supportForA = {};
  const supportForB = {};
  const aCnt = {}; staffA.forEach(s => { aCnt[s.id] = 0; });
  const bCnt = {}; staffB.forEach(s => { bCnt[s.id] = 0; });

  for (let d = 0; d < daysInMonth; d++) {
    const bUsed = new Set();
    const aUsed = new Set();
    const countA = { 早: 0, 日: 0, 遅: 0 };
    const countB = { 早: 0, 日: 0, 遅: 0 };
    staffA.forEach(s => { const v = resultA.schedule[s.id]?.[d]; if (countA[v] !== undefined) countA[v]++; });
    staffB.forEach(s => { const v = resultB.schedule[s.id]?.[d]; if (countB[v] !== undefined) countB[v]++; });

    // Bチームの休みスタッフがAチームを補う
    for (const shift of SHIFT_ORDER) {
      if (countA[shift] === 0) {
        const cands = staffB
          .filter(s => { const v = resultB.schedule[s.id]?.[d]; return (v==="休"||v==="有") && !bUsed.has(s.id); })
          .sort((a, b) => bCnt[a.id] - bCnt[b.id]);
        if (cands.length > 0) {
          const c = cands[0];
          if (!supportForA[d]) supportForA[d] = [];
          supportForA[d].push({ staffId: c.id, staffName: c.name, shift });
          bCnt[c.id]++;
          bUsed.add(c.id);
          countA[shift]++;
        }
      }
    }
    // Aチームの休みスタッフがBチームを補う
    for (const shift of SHIFT_ORDER) {
      if (countB[shift] === 0) {
        const cands = staffA
          .filter(s => { const v = resultA.schedule[s.id]?.[d]; return (v==="休"||v==="有") && !aUsed.has(s.id); })
          .sort((a, b) => aCnt[a.id] - aCnt[b.id]);
        if (cands.length > 0) {
          const c = cands[0];
          if (!supportForB[d]) supportForB[d] = [];
          supportForB[d].push({ staffId: c.id, staffName: c.name, shift });
          aCnt[c.id]++;
          aUsed.add(c.id);
          countB[shift]++;
        }
      }
    }
  }
  return { A: supportForA, B: supportForB };
}

// ============================================================
// チームシフトパネル（状態は親から受け取る）
// ============================================================
function TeamShiftPlanner({
  teamName, teamGrad,
  year, month, prevMonth, nextMonth,
  staffList, nextId,
  preferences,
  addStaff, removeStaff, setPreference, clearPreference,
  result, onGenerate,
  updateStaff,    // (id, patch) => void  スタッフ設定更新
  crossSupport,   // { [day0]: [{staffId, staffName, shift}] }  相手チームからの応援
  otherTeamName,
}) {
  const [showModal, setShowModal] = useState(false);
  const [activeTab, setActiveTab] = useState("希望入力");
  const [editingPref, setEditingPref] = useState(null);

  const daysInMonth = getDaysInMonth(year, month);
  const days = Array.from({ length: daysInMonth }, (_, i) => i + 1);

  const countShifts = staffId => {
    if (!result) return {};
    const c = { 早: 0, 日: 0, 遅: 0, 休: 0, 有: 0 };
    (result.schedule[staffId] || []).forEach(s => { if (s) c[s]++; });
    return c;
  };

  const alertSummary = result ? (() => {
    let shortage = 0, excess = 0;
    Object.values(result.flags).forEach(dayObj => {
      Object.values(dayObj).forEach(f => {
        if (f.type === "shortage") shortage++;
        if (f.type === "excess")   excess++;
      });
    });
    return { shortage, excess };
  })() : { shortage: 0, excess: 0 };

  const getCellFlag = (day0, shift) => result?.flags[day0]?.[shift] || null;
  const cellBg     = flag => (!flag || flag.type === "ok") ? null : flag.type === "shortage" ? SHORTAGE_BG : EXCESS_BG;
  const cellBorder = (flag, isPref, shift) => {
    if (isPref) return `2px solid ${SHIFTS[shift].color}`;
    if (!flag || flag.type === "ok") return "none";
    return flag.type === "shortage" ? `1.5px solid ${SHORTAGE_BORDER}` : `1.5px solid ${EXCESS_BORDER}`;
  };

  const needsMin2 = staffList.length < 2; // 早番・遅番の2枠が最小必要人数

  // 応援総件数（バッジ表示用）
  const totalSupport = Object.values(crossSupport || {}).reduce((sum, arr) => sum + arr.length, 0);

  return (
    <div style={{ fontFamily: "'Segoe UI','Hiragino Sans','Meiryo',sans-serif" }}>
      {showModal && (
        <StaffModal
          onAdd={name => { addStaff(name); setShowModal(false); }}
          onClose={() => setShowModal(false)}
        />
      )}

      {/* チームヘッダー */}
      <div style={{ background: teamGrad, color: "#fff", padding: "20px 32px", boxShadow: "0 4px 20px rgba(30,58,138,0.3)" }}>
        <div style={{ maxWidth: 1600, margin: "0 auto", display: "flex", alignItems: "center", justifyContent: "space-between", flexWrap: "wrap", gap: 12 }}>
          <div>
            <div style={{ fontSize: 11, letterSpacing: 3, opacity: 0.7, marginBottom: 4 }}>CARE SHIFT MANAGER</div>
            <h1 style={{ margin: 0, fontSize: 24, fontWeight: 800 }}>
              介護シフト管理　<span style={{ fontSize: 18, opacity: 0.85 }}>{teamName}</span>
            </h1>
            <div style={{ fontSize: 12, opacity: 0.75, marginTop: 4 }}>
              早番・遅番は毎日1人必須（遅番連続可）／日勤は0人以上・余剰で充当／日勤不足のみ互助
            </div>
          </div>
          <div style={{ display: "flex", alignItems: "center", gap: 12 }}>
            <button onClick={prevMonth} style={{ background: "rgba(255,255,255,0.15)", border: "none", color: "#fff", borderRadius: 8, padding: "8px 14px", cursor: "pointer", fontSize: 18, fontWeight: 700 }}>‹</button>
            <div style={{ textAlign: "center", minWidth: 130 }}>
              <div style={{ fontSize: 22, fontWeight: 800 }}>{year}年{month}月</div>
            </div>
            <button onClick={nextMonth} style={{ background: "rgba(255,255,255,0.15)", border: "none", color: "#fff", borderRadius: 8, padding: "8px 14px", cursor: "pointer", fontSize: 18, fontWeight: 700 }}>›</button>
          </div>
        </div>
      </div>

      <div style={{ maxWidth: 1600, margin: "0 auto", padding: "24px 16px" }}>

        {/* タブ */}
        <div style={{ display: "flex", gap: 4, marginBottom: 20, background: "#fff", borderRadius: 12, padding: 4, boxShadow: "0 2px 8px rgba(0,0,0,0.08)", width: "fit-content" }}>
          {["スタッフ管理", "希望入力", "シフト表"].map(tab => (
            <button key={tab} onClick={() => setActiveTab(tab)} style={{
              padding: "8px 20px", borderRadius: 9, border: "none", cursor: "pointer",
              background: activeTab === tab ? teamGrad : "transparent",
              color: activeTab === tab ? "#fff" : "#64748b",
              fontWeight: activeTab === tab ? 700 : 500, fontSize: 14, transition: "all 0.2s"
            }}>{tab}</button>
          ))}
        </div>

        {/* 凡例バー */}
        <div style={{ display: "flex", gap: 8, marginBottom: 20, flexWrap: "wrap", alignItems: "center" }}>
          {Object.entries(SHIFTS).map(([key, s]) => (
            <div key={key} style={{ display: "flex", alignItems: "center", gap: 6, background: s.bg, border: `1px solid ${s.color}`, borderRadius: 20, padding: "4px 12px" }}>
              <div style={{ width: 10, height: 10, borderRadius: "50%", background: s.color }} />
              <span style={{ fontSize: 13, color: s.text, fontWeight: 600 }}>{s.label}</span>
            </div>
          ))}
          <div style={{ display: "flex", alignItems: "center", gap: 6, background: SHORTAGE_BG, border: `1px solid ${SHORTAGE_BORDER}`, borderRadius: 20, padding: "4px 12px" }}>
            <div style={{ width: 10, height: 10, borderRadius: "50%", background: SHORTAGE_BORDER }} />
            <span style={{ fontSize: 13, color: SHORTAGE_BORDER, fontWeight: 700 }}>担当なし（0人）</span>
          </div>
          <div style={{ display: "flex", alignItems: "center", gap: 6, background: EXCESS_BG, border: `1px solid ${EXCESS_BORDER}`, borderRadius: 20, padding: "4px 12px" }}>
            <div style={{ width: 10, height: 10, borderRadius: "50%", background: EXCESS_BORDER }} />
            <span style={{ fontSize: 13, color: EXCESS_BORDER, fontWeight: 700 }}>早番・遅番が2人以上（過多）</span>
          </div>
          <div style={{ display: "flex", alignItems: "center", gap: 6, background: "#fef9ec", border: "1px solid #f59e0b", borderRadius: 20, padding: "4px 12px" }}>
            <div style={{ width: 10, height: 10, borderRadius: "50%", background: "#f59e0b" }} />
            <span style={{ fontSize: 13, color: "#92400e", fontWeight: 700 }}>応援（他チームカバー）</span>
          </div>
        </div>

        {/* ======== スタッフ管理 ======== */}
        {activeTab === "スタッフ管理" && (
          <div style={{ background: "#fff", borderRadius: 16, padding: 24, boxShadow: "0 4px 20px rgba(0,0,0,0.06)" }}>
            <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", marginBottom: 16 }}>
              <div>
                <h2 style={{ margin: "0 0 4px", fontSize: 18, color: "#1e293b", fontWeight: 700 }}>
                  スタッフ一覧　<span style={{ fontSize: 14, color: "#94a3b8", fontWeight: 400 }}>{staffList.length}名</span>
                </h2>
                <div style={{ fontSize: 13, color: needsMin2 ? SHORTAGE_BORDER : "#059669", fontWeight: 600 }}>
                  {needsMin2
                    ? `⚠ 早番1人・遅番1人を確保するには最低2名必要です（現在${staffList.length}名）`
                    : `✅ 早番・遅番を確保できます（${staffList.length}名）。残り${Math.max(staffList.length - 2, 0)}名が日勤または休みに割り当てられます`}
                </div>
              </div>
              <button onClick={() => setShowModal(true)} style={{ background: teamGrad, color: "#fff", border: "none", borderRadius: 10, padding: "10px 20px", cursor: "pointer", fontSize: 14, fontWeight: 600 }}>＋ スタッフを追加</button>
            </div>

            {/* 体制カード */}
            <div style={{ display: "flex", gap: 12, marginBottom: 20, flexWrap: "wrap" }}>
              {[
                { label: "早番", count: 1, color: "#F59E0B", desc: "必須（1名）" },
                { label: "日勤", count: `0〜${Math.max(staffList.length - 2, 0)}`, color: "#3B82F6", desc: "余剰（0人でも可）" },
                { label: "遅番", count: 1, color: "#8B5CF6", desc: "必須（1名）" },
                { label: "休　み", count: "〜10回/月", color: "#6B7280", desc: "目標" },
              ].map(item => (
                <div key={item.label} style={{ background: "#f8fafc", borderRadius: 12, padding: "12px 20px", borderLeft: `4px solid ${item.color}`, flex: "1 1 140px" }}>
                  <div style={{ fontSize: 12, color: "#94a3b8", fontWeight: 600 }}>{item.label}</div>
                  <div style={{ fontSize: 20, fontWeight: 800, color: item.color }}>{item.count}</div>
                  <div style={{ fontSize: 11, color: "#64748b" }}>{item.desc}</div>
                </div>
              ))}
            </div>

            <div style={{ display: "flex", flexDirection: "column", gap: 10 }}>
              {staffList.map((staff, idx) => (
                <div key={staff.id} style={{ display: "flex", alignItems: "center", gap: 12, padding: "12px 16px", borderRadius: 12, background: "#f8fafc", border: "1px solid #e2e8f0", flexWrap: "wrap" }}>
                  <div style={{ width: 36, height: 36, borderRadius: "50%", background: teamGrad, display: "flex", alignItems: "center", justifyContent: "center", color: "#fff", fontWeight: 700, fontSize: 15, flexShrink: 0 }}>{staff.name[0]}</div>
                  <div style={{ flex: 1, minWidth: 140 }}>
                    <div style={{ fontWeight: 700, color: "#1e293b", fontSize: 15 }}>{staff.name}</div>
                  </div>
                  {/* 休みタイプ切り替え */}
                  <div style={{ display: "flex", alignItems: "center", gap: 6 }}>
                    <span style={{ fontSize: 12, color: "#64748b", fontWeight: 600 }}>休みタイプ</span>
                    {REST_TYPES.map(t => (
                      <button key={t} onClick={() => updateStaff(staff.id, { restType: t })} style={{
                        padding: "4px 12px", borderRadius: 6, border: "none", cursor: "pointer", fontSize: 12, fontWeight: 700,
                        background: (staff.restType || "休") === t ? SHIFTS[t].bg : "#e2e8f0",
                        color: (staff.restType || "休") === t ? SHIFTS[t].text : "#94a3b8",
                        outline: (staff.restType || "休") === t ? `2px solid ${SHIFTS[t].color}` : "none",
                      }}>{SHIFTS[t].label.trim()}</button>
                    ))}
                  </div>
                  {/* 月間休み目標回数 */}
                  <div style={{ display: "flex", alignItems: "center", gap: 6 }}>
                    <span style={{ fontSize: 12, color: "#64748b", fontWeight: 600 }}>月間目標</span>
                    <button onClick={() => updateStaff(staff.id, { restTarget: Math.max(0, (staff.restTarget ?? 10) - 1) })} style={{ width: 24, height: 24, borderRadius: 6, border: "1px solid #e2e8f0", background: "#fff", cursor: "pointer", fontWeight: 700, fontSize: 14, display: "flex", alignItems: "center", justifyContent: "center" }}>−</button>
                    <span style={{ fontSize: 16, fontWeight: 800, color: "#1e293b", minWidth: 26, textAlign: "center" }}>{staff.restTarget ?? 10}</span>
                    <button onClick={() => updateStaff(staff.id, { restTarget: Math.min(31, (staff.restTarget ?? 10) + 1) })} style={{ width: 24, height: 24, borderRadius: 6, border: "1px solid #e2e8f0", background: "#fff", cursor: "pointer", fontWeight: 700, fontSize: 14, display: "flex", alignItems: "center", justifyContent: "center" }}>＋</button>
                    <span style={{ fontSize: 12, color: "#94a3b8" }}>回/月</span>
                  </div>
                  <button onClick={() => removeStaff(staff.id)} style={{ background: "none", border: "none", color: "#ef4444", cursor: "pointer", fontSize: 18, padding: "4px 8px", borderRadius: 6 }} title="削除">✕</button>
                </div>
              ))}
            </div>
          </div>
        )}

        {/* ======== 希望入力 ======== */}
        {activeTab === "希望入力" && (
          <div style={{ background: "#fff", borderRadius: 16, padding: 24, boxShadow: "0 4px 20px rgba(0,0,0,0.06)" }}>
            <div style={{ marginBottom: 16 }}>
              <h2 style={{ margin: "0 0 4px", fontSize: 18, color: "#1e293b", fontWeight: 700 }}>希望シフト入力</h2>
              <p style={{ margin: 0, fontSize: 13, color: "#64748b" }}>シフトセルをクリックして希望を設定してください。有給（有）は手動で入力してください。設定後「シフト生成」ボタンで反映されます。</p>
            </div>
            <div style={{ overflowX: "auto" }}>
              <table style={{ borderCollapse: "collapse", minWidth: "max-content" }}>
                <thead>
                  <tr>
                    <th style={{ padding: "8px 16px", background: "#f8fafc", color: "#475569", fontWeight: 700, fontSize: 13, textAlign: "left", border: "1px solid #e2e8f0", position: "sticky", left: 0, zIndex: 2, whiteSpace: "nowrap" }}>スタッフ</th>
                    {days.map(d => {
                      const dow = new Date(year, month - 1, d).getDay();
                      return (
                        <th key={d} style={{ padding: "6px 2px", background: dow === 0 ? "#fef2f2" : dow === 6 ? "#eff6ff" : "#f8fafc", color: dow === 0 ? "#dc2626" : dow === 6 ? "#2563eb" : "#475569", textAlign: "center", minWidth: 36, fontSize: 11, border: "1px solid #e2e8f0" }}>
                          <div style={{ fontWeight: 700 }}>{d}</div>
                          <div style={{ fontSize: 9, opacity: 0.8 }}>{DAYS_OF_WEEK[dow]}</div>
                        </th>
                      );
                    })}
                  </tr>
                </thead>
                <tbody>
                  {staffList.map(staff => (
                    <tr key={staff.id}>
                      <td style={{ padding: "8px 16px", background: "#f8fafc", fontWeight: 600, color: "#1e293b", position: "sticky", left: 0, zIndex: 1, border: "1px solid #e2e8f0", whiteSpace: "nowrap" }}>
                        <div style={{ display: "flex", alignItems: "center", gap: 6 }}>
                          <div style={{ width: 22, height: 22, borderRadius: "50%", background: teamGrad, display: "flex", alignItems: "center", justifyContent: "center", color: "#fff", fontWeight: 700, fontSize: 11, flexShrink: 0 }}>{staff.name[0]}</div>
                          <span style={{ fontSize: 13 }}>{staff.name}</span>
                        </div>
                      </td>
                      {days.map(d => {
                        const pref = preferences[staff.id]?.[d];
                        const isEditing = editingPref?.staffId === staff.id && editingPref?.day === d;
                        return (
                          <td key={d} style={{ padding: 2, textAlign: "center", border: "1px solid #e2e8f0" }}>
                            {isEditing ? (
                              <div style={{ display: "flex", flexWrap: "wrap", gap: 2, justifyContent: "center", padding: 4, background: "#f0f9ff", borderRadius: 6 }}>
                                {Object.keys(SHIFTS).map(s => (
                                  <button key={s} onClick={() => setPreference(staff.id, d, s)} style={{ padding: "2px 6px", borderRadius: 4, border: `1px solid ${SHIFTS[s].color}`, background: SHIFTS[s].bg, color: SHIFTS[s].text, cursor: "pointer", fontSize: 11, fontWeight: 700 }}>{SHIFTS[s].short}</button>
                                ))}
                                <button onClick={() => { clearPreference(staff.id, d); setEditingPref(null); }} style={{ padding: "2px 6px", borderRadius: 4, border: "1px solid #e2e8f0", background: "#fff", color: "#94a3b8", cursor: "pointer", fontSize: 11 }}>×</button>
                              </div>
                            ) : (
                              <div
                                onClick={() => setEditingPref({ staffId: staff.id, day: d })}
                                style={{ height: 32, display: "flex", alignItems: "center", justifyContent: "center", borderRadius: 6, cursor: "pointer", fontWeight: 700, fontSize: 13, background: pref ? SHIFTS[pref].bg : "transparent", color: pref ? SHIFTS[pref].text : "#cbd5e1", border: pref ? `2px solid ${SHIFTS[pref].color}` : "2px dashed #e2e8f0", transition: "all 0.15s" }}
                                title="クリックして希望を設定"
                              >
                                {pref ? SHIFTS[pref].short : "+"}
                              </div>
                            )}
                          </td>
                        );
                      })}
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
            <div style={{ marginTop: 20, display: "flex", justifyContent: "flex-end" }}>
              <button onClick={onGenerate} style={{ background: teamGrad, color: "#fff", border: "none", borderRadius: 12, padding: "14px 40px", fontSize: 16, fontWeight: 700, cursor: "pointer", boxShadow: "0 4px 12px rgba(30,58,138,0.3)", transition: "all 0.2s" }}>
                🔄 両チーム合同シフト生成
              </button>
            </div>
          </div>
        )}

        {/* ======== シフト表 ======== */}
        {activeTab === "シフト表" && (
          <div style={{ background: "#fff", borderRadius: 16, padding: 24, boxShadow: "0 4px 20px rgba(0,0,0,0.06)" }}>
            <div style={{ display: "flex", justifyContent: "space-between", alignItems: "flex-start", marginBottom: 20, flexWrap: "wrap", gap: 12 }}>
              <div>
                <h2 style={{ margin: "0 0 4px", fontSize: 18, color: "#1e293b", fontWeight: 700 }}>{year}年{month}月　シフト表</h2>
                <div style={{ fontSize: 13, color: "#64748b" }}>
                  {needsMin2
                    ? `⚠ 早番1人・遅番1人を確保するには最低2名必要です（現在${staffList.length}名）`
                    : `✅ 早番・遅番を確保できます（${staffList.length}名）。残り${Math.max(staffList.length - 2, 0)}名が日勤または休みに割り当てられます`}
                </div>
              </div>
              <div style={{ display: "flex", gap: 12, flexWrap: "wrap", alignItems: "center" }}>
                {alertSummary.shortage > 0 && (
                  <div style={{ padding: "6px 14px", borderRadius: 20, background: SHORTAGE_BG, border: `1.5px solid ${SHORTAGE_BORDER}`, color: SHORTAGE_BORDER, fontWeight: 700, fontSize: 13 }}>
                    ⚠ 不足 {alertSummary.shortage}件
                  </div>
                )}
                {alertSummary.excess > 0 && (
                  <div style={{ padding: "6px 14px", borderRadius: 20, background: EXCESS_BG, border: `1.5px solid ${EXCESS_BORDER}`, color: EXCESS_BORDER, fontWeight: 700, fontSize: 13 }}>
                    ⚠ 過多 {alertSummary.excess}件
                  </div>
                )}
                {totalSupport > 0 && (
                  <div style={{ padding: "6px 14px", borderRadius: 20, background: "#fef9ec", border: "1.5px solid #f59e0b", color: "#92400e", fontWeight: 700, fontSize: 13 }}>
                    🤝 {otherTeamName}応援 {totalSupport}件
                  </div>
                )}
                <button onClick={onGenerate} style={{ background: teamGrad, color: "#fff", border: "none", borderRadius: 10, padding: "10px 24px", cursor: "pointer", fontSize: 14, fontWeight: 700, boxShadow: "0 2px 8px rgba(30,58,138,0.2)" }}>
                  🔄 再生成
                </button>
              </div>
            </div>

            {!result ? (
              <div style={{ textAlign: "center", padding: "60px 20px", color: "#94a3b8" }}>
                <div style={{ fontSize: 48, marginBottom: 16 }}>📅</div>
                <div style={{ fontSize: 16, fontWeight: 600 }}>まだシフトが生成されていません</div>
                <div style={{ fontSize: 13, marginTop: 8 }}>「希望入力」タブから「両チーム合同シフト生成」ボタンを押してください</div>
              </div>
            ) : (
              <>
                <div style={{ overflowX: "auto" }}>
                  <table style={{ borderCollapse: "collapse", minWidth: "max-content" }}>
                    <thead>
                      <tr>
                        <th style={{ padding: "8px 16px", background: "#1e293b", color: "#fff", fontWeight: 700, fontSize: 13, textAlign: "left", border: "1px solid #475569", position: "sticky", left: 0, zIndex: 2, whiteSpace: "nowrap" }}>スタッフ</th>
                        {days.map(d => {
                          const dow = new Date(year, month - 1, d).getDay();
                          const dayFlags = result.flags[d - 1] || {};
                          // 応援込みの充足チェック
                          const supArr = crossSupport[d - 1] || [];
                          const supE = supArr.filter(c => c.shift === "早").length;
                          const supL = supArr.filter(c => c.shift === "遅").length;
                          const eTotal = staffList.filter(s => result.schedule[s.id]?.[d-1] === "早").length + supE;
                          const lTotal = staffList.filter(s => result.schedule[s.id]?.[d-1] === "遅").length + supL;
                          // 日勤は0人でも良いため、不足判定は早番・遅番のみで行う
                          const hasShortage = eTotal === 0 || lTotal === 0;
                          const hasExcess = Object.values(dayFlags).some(f => f.type === "excess");
                          const hasSupport = supArr.length > 0;
                          const hdrBg = hasShortage ? SHORTAGE_HDR : hasExcess ? EXCESS_HDR : hasSupport ? "#fef9ec" : dow === 0 ? "#fef2f2" : dow === 6 ? "#eff6ff" : "#f8fafc";
                          const hdrBorder = hasShortage ? `1.5px solid ${SHORTAGE_BORDER}` : hasExcess ? `1.5px solid ${EXCESS_BORDER}` : hasSupport ? "1.5px solid #f59e0b" : "1px solid #e2e8f0";
                          return (
                            <th key={d} style={{ padding: "6px 2px", background: hdrBg, color: dow === 0 ? "#dc2626" : dow === 6 ? "#2563eb" : "#475569", textAlign: "center", minWidth: 34, fontSize: 11, border: hdrBorder }}>
                              <div style={{ fontWeight: 700 }}>{d}</div>
                              <div style={{ fontSize: 9, opacity: 0.8 }}>{DAYS_OF_WEEK[dow]}</div>
                              {hasShortage && <div style={{ fontSize: 8, color: SHORTAGE_BORDER, fontWeight: 800, marginTop: 1 }}>⚠</div>}
                              {!hasShortage && hasSupport && <div style={{ fontSize: 8, color: "#f59e0b", fontWeight: 800, marginTop: 1 }}>🤝</div>}
                            </th>
                          );
                        })}
                        <th style={{ padding: "6px 8px", background: "#f8fafc", textAlign: "center", fontSize: 11, border: "1px solid #e2e8f0", whiteSpace: "nowrap", minWidth: 90 }}>集計</th>
                      </tr>
                    </thead>
                    <tbody>
                      {staffList.map(staff => {
                        const counts = countShifts(staff.id);
                        return (
                          <tr key={staff.id}>
                            <td style={{ padding: "8px 16px", background: "#f8fafc", fontWeight: 600, color: "#1e293b", position: "sticky", left: 0, zIndex: 1, border: "1px solid #e2e8f0", whiteSpace: "nowrap" }}>
                              <div style={{ display: "flex", alignItems: "center", gap: 6 }}>
                                <div style={{ width: 22, height: 22, borderRadius: "50%", background: teamGrad, display: "flex", alignItems: "center", justifyContent: "center", color: "#fff", fontWeight: 700, fontSize: 11, flexShrink: 0 }}>{staff.name[0]}</div>
                                <span style={{ fontSize: 13 }}>{staff.name}</span>
                              </div>
                            </td>
                            {(result.schedule[staff.id] || []).map((shift, i) => {
                              const isPref = preferences[staff.id]?.[i + 1] !== undefined;
                              const flag = getCellFlag(i, shift);
                              const isAlert = flag && flag.type !== "ok";
                              const s = SHIFTS[shift] || SHIFTS["休"];
                              const bg = cellBg(flag);
                              const border = cellBorder(flag, isPref, shift);
                              return (
                                <td key={i} style={{ padding: 2, textAlign: "center", background: bg || "transparent", border: isAlert ? (flag.type === "shortage" ? `1px solid ${SHORTAGE_BORDER}` : `1px solid ${EXCESS_BORDER}`) : "1px solid #e2e8f0" }}>
                                  <div style={{ height: 30, display: "flex", alignItems: "center", justifyContent: "center", borderRadius: 6, fontWeight: 700, fontSize: 12, position: "relative", background: s.bg, color: s.text, border }}>
                                    {s.short}
                                    {isPref && <div style={{ position: "absolute", top: -3, right: -3, width: 7, height: 7, borderRadius: "50%", background: "#f59e0b", border: "1px solid #fff" }} title="希望シフト" />}
                                  </div>
                                </td>
                              );
                            })}
                            <td style={{ padding: "4px 8px", border: "1px solid #e2e8f0", background: "#fafafa" }}>
                              <div style={{ display: "flex", flexDirection: "column", gap: 2 }}>
                                {["早", "日", "遅"].map(k => {
                                  const avg = result.fairnessAvg ? result.fairnessAvg[k] : null;
                                  const diff = avg !== null ? counts[k] - avg : 0;
                                  // 公平性警告は日勤のみ（早番・遅番は必須確保優先のためずれ許容）
                                  const isOff = k === "日" && avg !== null && Math.abs(diff) >= 2;
                                  return (
                                    <div key={k} style={{ display: "flex", alignItems: "center", gap: 4, justifyContent: "space-between" }}>
                                      <span style={{ fontSize: 10, fontWeight: 700, color: SHIFTS[k].text, background: SHIFTS[k].bg, padding: "1px 4px", borderRadius: 4, minWidth: 22, textAlign: "center" }}>{SHIFTS[k].short}</span>
                                      <span style={{ fontSize: 11, color: isOff ? "#d97706" : "#475569", fontWeight: 700 }}>{counts[k]}{isOff && <span style={{ fontSize: 9 }}>⚠</span>}</span>
                                    </div>
                                  );
                                })}
                                {result.restSummary && (() => {
                                  const rs = result.restSummary[staff.id];
                                  const ok = rs.actual === rs.target;
                                  return (
                                    <>
                                      <div style={{ display: "flex", alignItems: "center", gap: 4, justifyContent: "space-between", borderTop: "1px dashed #e2e8f0", paddingTop: 2, marginTop: 2 }}>
                                        <span style={{ fontSize: 10, fontWeight: 700, color: SHIFTS[rs.restType].text, background: SHIFTS[rs.restType].bg, padding: "1px 4px", borderRadius: 4, minWidth: 22, textAlign: "center" }}>{SHIFTS[rs.restType].short}</span>
                                        <span style={{ fontSize: 11, fontWeight: 700, color: ok ? "#166534" : "#d97706" }}>{rs.actual}/{rs.target}{!ok && "⚠"}</span>
                                      </div>
                                      {rs.manualPaidLeave > 0 && (
                                        <div style={{ display: "flex", alignItems: "center", gap: 4, justifyContent: "space-between" }}>
                                          <span style={{ fontSize: 10, fontWeight: 700, color: SHIFTS["有"].text, background: SHIFTS["有"].bg, padding: "1px 4px", borderRadius: 4, minWidth: 22, textAlign: "center" }}>{SHIFTS["有"].short}</span>
                                          <span style={{ fontSize: 11, color: "#475569", fontWeight: 600 }}>{rs.manualPaidLeave}<span style={{ fontSize: 9, opacity: 0.7 }}>（手動）</span></span>
                                        </div>
                                      )}
                                    </>
                                  );
                                })()}
                              </div>
                            </td>
                          </tr>
                        );
                      })}
                    </tbody>

                    {/* フッター */}
                    <tfoot>
                      {/* シフト別人数行 */}
                      {["早", "日", "遅"].map(shiftKey => (
                        <tr key={shiftKey}>
                          <td style={{ padding: "6px 16px", position: "sticky", left: 0, zIndex: 1, background: SHIFTS[shiftKey].bg, color: SHIFTS[shiftKey].text, fontWeight: 700, fontSize: 12, border: "1px solid #e2e8f0", whiteSpace: "nowrap" }}>
                            {SHIFTS[shiftKey].label}　人数
                          </td>
                          {days.map(d => {
                            const cnt = staffList.filter(s => result.schedule[s.id]?.[d - 1] === shiftKey).length;
                            const sup = (crossSupport[d - 1] || []).filter(c => c.shift === shiftKey).length;
                            const total = cnt + sup;
                            const flag = result.flags[d - 1]?.[shiftKey];
                            // 日勤は0人でも不足扱いしない（早番・遅番のみ不足判定）
                            const isShortage = shiftKey !== "日" && total === 0;
                            const isExcess = flag?.type === "excess";
                            const hasSupp = sup > 0;
                            return (
                              <td key={d} style={{
                                textAlign: "center", padding: "4px 2px", fontWeight: 700, fontSize: 12,
                                background: isShortage ? SHORTAGE_BG : isExcess ? EXCESS_BG : hasSupp ? "#fef9ec" : SHIFTS[shiftKey].bg,
                                color: isShortage ? SHORTAGE_BORDER : isExcess ? EXCESS_BORDER : hasSupp ? "#92400e" : SHIFTS[shiftKey].text,
                                border: isShortage ? `2px solid ${SHORTAGE_BORDER}` : isExcess ? `2px solid ${EXCESS_BORDER}` : hasSupp ? "1.5px solid #f59e0b" : "1px solid #e2e8f0",
                              }}>
                                {isShortage ? <span title="担当なし">0⚠</span>
                                  : isExcess ? <span title="人員過多">{total}⚠</span>
                                  : hasSupp ? <span title={`自チーム${cnt}+応援${sup}`}>{cnt}<span style={{ fontSize: 9 }}>+🤝</span></span>
                                  : total}
                              </td>
                            );
                          })}
                          <td style={{ border: "1px solid #e2e8f0", background: SHIFTS[shiftKey].bg }} />
                        </tr>
                      ))}

                      {/* 応援スタッフ行（他チームからの応援が発生した日のみ表示） */}
                      {Object.keys(crossSupport).length > 0 && (
                        <tr>
                          <td style={{ padding: "6px 16px", position: "sticky", left: 0, zIndex: 1, background: "#78350f", color: "#fef9ec", fontWeight: 700, fontSize: 11, border: "1px solid #92400e", whiteSpace: "nowrap" }}>
                            🤝 {otherTeamName}応援
                          </td>
                          {days.map(d => {
                            const supArr = crossSupport[d - 1] || [];
                            return (
                              <td key={d} style={{
                                textAlign: "center", padding: "3px 1px", fontSize: 9, fontWeight: 700,
                                background: supArr.length > 0 ? "#fef9ec" : "transparent",
                                border: supArr.length > 0 ? "1.5px solid #f59e0b" : "1px solid #e2e8f0",
                                color: "#92400e",
                                verticalAlign: "middle",
                              }}>
                                {supArr.map((c, i) => (
                                  <div key={i} title={`${c.staffName}（${SHIFTS[c.shift].label}）`} style={{ lineHeight: 1.3 }}>
                                    <span style={{ background: SHIFTS[c.shift].bg, color: SHIFTS[c.shift].text, padding: "1px 3px", borderRadius: 3, fontSize: 9 }}>{SHIFTS[c.shift].short}</span>
                                    <div style={{ fontSize: 8, color: "#92400e" }}>{c.staffName.split(" ")[0].slice(0, 3)}</div>
                                  </div>
                                ))}
                              </td>
                            );
                          })}
                          <td style={{ border: "1px solid #92400e", background: "#78350f" }} />
                        </tr>
                      )}

                      {/* 充足チェック行（応援込み） */}
                      <tr>
                        <td style={{ padding: "6px 16px", position: "sticky", left: 0, zIndex: 1, background: "#1e293b", color: "#fff", fontWeight: 700, fontSize: 12, border: "1px solid #475569", whiteSpace: "nowrap" }}>
                          早・遅 充足（必須）
                        </td>
                        {days.map(d => {
                          const supArr = crossSupport[d - 1] || [];
                          const earlyCnt = staffList.filter(s => result.schedule[s.id]?.[d - 1] === "早").length + supArr.filter(c => c.shift === "早").length;
                          const dayCnt   = staffList.filter(s => result.schedule[s.id]?.[d - 1] === "日").length + supArr.filter(c => c.shift === "日").length;
                          const lateCnt  = staffList.filter(s => result.schedule[s.id]?.[d - 1] === "遅").length + supArr.filter(c => c.shift === "遅").length;
                          // 日勤は0人以上でOK。早番・遅番のみ必須チェック
                          const ok = earlyCnt >= 1 && lateCnt >= 1;
                          const hasShortage = earlyCnt === 0 || lateCnt === 0;
                          const hasSupport = supArr.length > 0;
                          return (
                            <td key={d} style={{
                              textAlign: "center", padding: "6px 2px", fontWeight: 700, fontSize: 13,
                              background: ok ? (hasSupport ? "#fef9ec" : "#f0fdf4") : hasShortage ? SHORTAGE_BG : EXCESS_BG,
                              color: ok ? (hasSupport ? "#92400e" : "#166534") : hasShortage ? SHORTAGE_BORDER : EXCESS_BORDER,
                              border: ok ? (hasSupport ? "1.5px solid #f59e0b" : "1px solid #86efac") : hasShortage ? `2px solid ${SHORTAGE_BORDER}` : `2px solid ${EXCESS_BORDER}`,
                            }}>
                              {ok ? (hasSupport ? "🤝" : "✓") : <span style={{ fontSize: 9 }}>⚠</span>}
                            </td>
                          );
                        })}
                        <td style={{ border: "1px solid #475569", background: "#1e293b" }} />
                      </tr>

                      {/* 休み人数行 */}
                      <tr>
                        <td style={{ padding: "6px 16px", position: "sticky", left: 0, zIndex: 1, background: "#334155", color: "#fff", fontWeight: 700, fontSize: 12, border: "1px solid #475569", whiteSpace: "nowrap" }}>
                          休み人数（休＋有）
                        </td>
                        {days.map(d => {
                          const restCnt = staffList.filter(s => { const v = result.schedule[s.id]?.[d - 1]; return v === "休" || v === "有"; }).length;
                          const over = restCnt > 2;
                          return (
                            <td key={d} style={{
                              textAlign: "center", padding: "6px 2px", fontWeight: 700, fontSize: 13,
                              background: over ? EXCESS_BG : "#f8fafc",
                              color: over ? EXCESS_BORDER : "#475569",
                              border: over ? `2px solid ${EXCESS_BORDER}` : "1px solid #e2e8f0",
                            }}>
                              {restCnt}{over && <span style={{ fontSize: 9 }}>⚠</span>}
                            </td>
                          );
                        })}
                        <td style={{ border: "1px solid #475569", background: "#334155" }} />
                      </tr>
                    </tfoot>
                  </table>
                </div>

                {/* 注釈 */}
                <div style={{ marginTop: 14, display: "flex", gap: 16, color: "#64748b", fontSize: 12, flexWrap: "wrap", alignItems: "center", paddingTop: 12, borderTop: "1px solid #f1f5f9" }}>
                  <div style={{ display: "flex", alignItems: "center", gap: 5 }}>
                    <div style={{ width: 14, height: 14, background: SHORTAGE_BG, border: `1.5px solid ${SHORTAGE_BORDER}`, borderRadius: 3 }} />
                    <span style={{ color: SHORTAGE_BORDER, fontWeight: 600 }}>早番・遅番の担当なし（0人）</span>
                  </div>
                  <div style={{ display: "flex", alignItems: "center", gap: 5 }}>
                    <div style={{ width: 14, height: 14, background: EXCESS_BG, border: `1.5px solid ${EXCESS_BORDER}`, borderRadius: 3 }} />
                    <span style={{ color: EXCESS_BORDER, fontWeight: 600 }}>早番・遅番が2人以上（過多）</span>
                  </div>
                  <div style={{ display: "flex", alignItems: "center", gap: 5 }}>
                    <div style={{ width: 14, height: 14, background: "#f0fdf4", border: "1px solid #86efac", borderRadius: 3 }} />
                    <span style={{ color: "#166534" }}>早番1人・遅番1人を充足（日勤は0人でも可）</span>
                  </div>
                  <div style={{ display: "flex", alignItems: "center", gap: 5 }}>
                    <div style={{ width: 14, height: 14, background: "#fef9ec", border: "1.5px solid #f59e0b", borderRadius: 3 }} />
                    <span style={{ color: "#92400e" }}>🤝 他チームが応援カバー済み</span>
                  </div>
                  <div style={{ display: "flex", alignItems: "center", gap: 5 }}>
                    <div style={{ width: 10, height: 10, borderRadius: "50%", background: "#f59e0b", border: "2px solid #fff", boxShadow: "0 0 0 1px #ccc" }} />
                    <span>希望シフト反映済み</span>
                  </div>
                  <span style={{ color: "#94a3b8" }}>※ 🤝マークの日は応援スタッフを含めた合計で充足しています</span>
                </div>
              </>
            )}
          </div>
        )}
      </div>
    </div>
  );
}

// ============================================================
// チーム選択ラッパー（AチームとBチームの状態を一元管理し、互助シフトを計算）
// ============================================================
const TEAM_A_STAFF_INIT = [
  { id: 1, name: "田中 花子", restTarget: 10, restType: "休" },
  { id: 2, name: "佐藤 一郎", restTarget: 10, restType: "休" },
  { id: 3, name: "鈴木 美咲", restTarget: 10, restType: "休" },
  { id: 4, name: "山本 健二", restTarget: 10, restType: "休" },
  { id: 5, name: "伊藤さくら", restTarget: 10, restType: "休" },
];
const TEAM_B_STAFF_INIT = [
  { id: 1, name: "スタッフ１", restTarget: 10, restType: "休" },
  { id: 2, name: "スタッフ２", restTarget: 10, restType: "休" },
  { id: 3, name: "スタッフ３", restTarget: 10, restType: "休" },
  { id: 4, name: "スタッフ４", restTarget: 10, restType: "休" },
  { id: 5, name: "スタッフ５", restTarget: 10, restType: "休" },
];
const TEAM_A_GRAD = "linear-gradient(135deg,#1e3a8a 0%,#4c1d95 100%)";
const TEAM_B_GRAD = "linear-gradient(135deg,#065f46 0%,#0f766e 100%)";

export default function ShiftPlanner() {
  const now = new Date();
  const [activeTeam, setActiveTeam] = useState("A");

  // 共通年月
  const [year,  setYear]  = useState(now.getFullYear());
  const [month, setMonth] = useState(now.getMonth() + 1);

  // Aチーム
  const [teamAStaff,  setTeamAStaff]  = useState(TEAM_A_STAFF_INIT);
  const [teamANextId, setTeamANextId] = useState(6);
  const [teamAPrefs,  setTeamAPrefs]  = useState({});
  const [teamAResult, setTeamAResult] = useState(null);

  // Bチーム
  const [teamBStaff,  setTeamBStaff]  = useState(TEAM_B_STAFF_INIT);
  const [teamBNextId, setTeamBNextId] = useState(6);
  const [teamBPrefs,  setTeamBPrefs]  = useState({});
  const [teamBResult, setTeamBResult] = useState(null);

  // 互助データ { A: {[day0]:[{staffId,staffName,shift}]}, B: {...} }
  const [crossSupport, setCrossSupport] = useState({ A: {}, B: {} });

  // 月移動（両チームの結果をリセット）
  const prevMonth = useCallback(() => {
    if (month === 1) { setYear(y => y - 1); setMonth(12); } else setMonth(m => m - 1);
    setTeamAResult(null); setTeamBResult(null); setCrossSupport({ A: {}, B: {} });
  }, [month]);
  const nextMonth = useCallback(() => {
    if (month === 12) { setYear(y => y + 1); setMonth(1); } else setMonth(m => m + 1);
    setTeamAResult(null); setTeamBResult(null); setCrossSupport({ A: {}, B: {} });
  }, [month]);

  // 両チーム合同シフト生成 + 互助計算
  const handleGenerate = useCallback(() => {
    const resA = generateShifts(teamAStaff, year, month, teamAPrefs);
    const resB = generateShifts(teamBStaff, year, month, teamBPrefs);
    const support = computeCrossSupport(resA, teamAStaff, resB, teamBStaff, year, month);
    setTeamAResult(resA);
    setTeamBResult(resB);
    setCrossSupport(support);
  }, [teamAStaff, teamBStaff, year, month, teamAPrefs, teamBPrefs]);

  // スタッフ個別設定更新（restTarget / restType）
  const updateStaffA = useCallback((id, patch) => setTeamAStaff(p => p.map(s => s.id === id ? {...s, ...patch} : s)), []);
  const updateStaffB = useCallback((id, patch) => setTeamBStaff(p => p.map(s => s.id === id ? {...s, ...patch} : s)), []);

  // Aチーム操作
  const addStaffA    = useCallback(name => { setTeamAStaff(p => [...p, { id: teamANextId, name, restTarget: 10, restType: "休" }]); setTeamANextId(p => p + 1); }, [teamANextId]);
  const removeStaffA = useCallback(id   => { setTeamAStaff(p => p.filter(s => s.id !== id)); setTeamAPrefs(p => { const n = {...p}; delete n[id]; return n; }); }, []);
  const setPrefA     = useCallback((sId, day, shift) => setTeamAPrefs(p => ({...p, [sId]: {...(p[sId]||{}), [day]: shift}})), []);
  const clearPrefA   = useCallback((sId, day) => setTeamAPrefs(p => { const n = {...p}; if(n[sId]) delete n[sId][day]; return n; }), []);

  // Bチーム操作
  const addStaffB    = useCallback(name => { setTeamBStaff(p => [...p, { id: teamBNextId, name, restTarget: 10, restType: "休" }]); setTeamBNextId(p => p + 1); }, [teamBNextId]);
  const removeStaffB = useCallback(id   => { setTeamBStaff(p => p.filter(s => s.id !== id)); setTeamBPrefs(p => { const n = {...p}; delete n[id]; return n; }); }, []);
  const setPrefB     = useCallback((sId, day, shift) => setTeamBPrefs(p => ({...p, [sId]: {...(p[sId]||{}), [day]: shift}})), []);
  const clearPrefB   = useCallback((sId, day) => setTeamBPrefs(p => { const n = {...p}; if(n[sId]) delete n[sId][day]; return n; }), []);

  return (
    <div style={{ minHeight: "100vh", background: "linear-gradient(135deg,#f0f4ff 0%,#faf5ff 100%)", fontFamily: "'Segoe UI','Hiragino Sans','Meiryo',sans-serif" }}>

      {/* チーム切り替えバー */}
      <div style={{ background: "#fff", borderBottom: "2px solid #e2e8f0", padding: "12px 32px", display: "flex", alignItems: "center", gap: 12, boxShadow: "0 2px 8px rgba(0,0,0,0.06)" }}>
        <span style={{ fontSize: 13, fontWeight: 700, color: "#64748b", letterSpacing: 1, marginRight: 8 }}>チーム切り替え</span>
        {[
          { key: "A", label: "Aチーム（班）", grad: TEAM_A_GRAD, result: teamAResult, cross: crossSupport.B },
          { key: "B", label: "Bチーム（班）", grad: TEAM_B_GRAD, result: teamBResult, cross: crossSupport.A },
        ].map(({ key, label, grad, result: r, cross }) => {
          const supportSent = Object.values(cross || {}).reduce((s, a) => s + a.length, 0);
          return (
            <button key={key} onClick={() => setActiveTeam(key)} style={{
              padding: "10px 28px", borderRadius: 10, border: "none", cursor: "pointer",
              background: activeTeam === key ? grad : "#f1f5f9",
              color: activeTeam === key ? "#fff" : "#475569",
              fontWeight: activeTeam === key ? 800 : 600,
              fontSize: 15,
              boxShadow: activeTeam === key ? "0 4px 12px rgba(0,0,0,0.18)" : "none",
              transition: "all 0.2s",
              position: "relative",
            }}>
              {label}
              {r && supportSent > 0 && (
                <span style={{ marginLeft: 8, background: "#f59e0b", color: "#fff", borderRadius: 10, padding: "1px 7px", fontSize: 11, fontWeight: 700 }}>
                  応援{supportSent}件
                </span>
              )}
            </button>
          );
        })}
        <span style={{ fontSize: 12, color: "#94a3b8", marginLeft: 8 }}>
          ※ シフト不足時は相手チームの休みスタッフが自動で応援に入ります
        </span>
      </div>

      {/* 両チームをレンダリング（displayで切替・状態は親保持）*/}
      <div style={{ display: activeTeam === "A" ? "block" : "none" }}>
        <TeamShiftPlanner
          teamName="Aチーム（班）"  teamGrad={TEAM_A_GRAD}  otherTeamName="Bチーム"
          year={year} month={month} prevMonth={prevMonth} nextMonth={nextMonth}
          staffList={teamAStaff}   nextId={teamANextId}
          preferences={teamAPrefs}
          addStaff={addStaffA}     removeStaff={removeStaffA}
          setPreference={setPrefA} clearPreference={clearPrefA}
          result={teamAResult}     onGenerate={handleGenerate}
          updateStaff={updateStaffA}
          crossSupport={crossSupport.A || {}}
        />
      </div>
      <div style={{ display: activeTeam === "B" ? "block" : "none" }}>
        <TeamShiftPlanner
          teamName="Bチーム（班）"  teamGrad={TEAM_B_GRAD}  otherTeamName="Aチーム"
          year={year} month={month} prevMonth={prevMonth} nextMonth={nextMonth}
          staffList={teamBStaff}   nextId={teamBNextId}
          preferences={teamBPrefs}
          addStaff={addStaffB}     removeStaff={removeStaffB}
          setPreference={setPrefB} clearPreference={clearPrefB}
          result={teamBResult}     onGenerate={handleGenerate}
          updateStaff={updateStaffB}
          crossSupport={crossSupport.B || {}}
        />
      </div>
    </div>
  );
}
