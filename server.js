// server.js
const express = require('express');
const path = require('path');
const { createClient } = require('@supabase/supabase-js');

const app = express();
const PORT = process.env.PORT || 5173;


// ใส่ค่าจาก Supabase Settings > API
const SUPABASE_URL = 'https://wpgezknhdbmwkflgqlji.supabase.co';
const SUPABASE_KEY = 'sb_publishable_pGJBkK9topY-CzQGvWTarQ_vN2zktPX';

const supabase = createClient(SUPABASE_URL, SUPABASE_KEY);

app.use(express.json());
app.use(express.static(path.join(__dirname, 'public')));

// ---------- ฟังก์ชันช่วยคำนวณ Level / Badge / วันที่ ----------

function calcLevel(totalXp) {
  // สูตรง่าย ๆ: XP ยิ่งเยอะ เลเวลยิ่งสูง
  const lvl = Math.floor(Math.sqrt(totalXp / 100)) + 1;
  return Math.max(1, lvl);
}

function calcBadges(stats) {
  const badges = [];
  const totalPlays = stats.total_plays || 0;
  const bestScore = stats.best_score || 0;

  if (totalPlays >= 1) badges.push('First Tap');
  if (totalPlays >= 10) badges.push('10 Rounds');
  if (totalPlays >= 50) badges.push('Grinder 50');
  if (totalPlays >= 100) badges.push('Grinder 100');

  if (bestScore >= 15) badges.push('Fast 15');
  if (bestScore >= 20) badges.push('Fast 20');
  if (bestScore >= 25) badges.push('Monster Fingers');

  return badges;
}

function getTodayStr() {
  // yyyy-mm-dd (ใช้เวลา UTC แบบง่าย ๆ ก่อน)
  return new Date().toISOString().slice(0, 10);
}

// ---------- API: ส่งคะแนน + XP/Level + Daily Mission + Points + BigTap + Anti-cheat ----------
app.post('/api/submit-score', async (req, res) => {
  try {
    let { studentId, walletAddress, taps, tapTimestamps, useBoost, useBigTap } =
      req.body;

    if (!studentId || typeof taps !== 'number') {
      return res.status(400).json({ ok: false, message: 'ข้อมูลไม่ถูกต้อง' });
    }

    // anti-cheat 1: เพดาน taps ต่อ 1 วิ
    if (taps > 25) {
      return res
        .status(400)
        .json({ ok: false, message: 'คะแนนผิดปกติ (เกิน 25 ครั้ง/วิ)' });
    }

    // anti-cheat 2: ตรวจรูปแบบเวลาแตะ ถ้ามีข้อมูล tapTimestamps ส่งมา
    if (Array.isArray(tapTimestamps) && tapTimestamps.length > 0) {
      if (tapTimestamps.length !== taps) {
        return res
          .status(400)
          .json({ ok: false, message: 'รูปแบบข้อมูลแตะไม่ถูกต้อง' });
      }

      const intervals = [];
      for (let i = 1; i < tapTimestamps.length; i++) {
        intervals.push(tapTimestamps[i] - tapTimestamps[i - 1]);
      }

      if (intervals.length > 0) {
        const minInterval = Math.min(...intervals);
        const avgInterval =
          intervals.reduce((a, b) => a + b, 0) / intervals.length;
        const variance =
          intervals.reduce((sum, x) => sum + Math.pow(x - avgInterval, 2), 0) /
          intervals.length;
        const stdDev = Math.sqrt(variance);

        if (minInterval < 20 && taps >= 10) {
          return res.status(400).json({
            ok: false,
            message: 'รูปแบบการแตะผิดปกติ (เร็วเกินมนุษย์)'
          });
        }

        if (stdDev < 2 && taps >= 10) {
          return res.status(400).json({
            ok: false,
            message: 'รูปแบบการแตะสม่ำเสมอเกินไป (อาจเป็นสคริปต์)'
          });
        }
      }
    }

    const todayStr = getTodayStr();
    const BIG_TAP_LIMIT = 10;

    let xpMultiplier = 1;
    let xpGain = 0;
    let usedBoostEffective = false;
    let pointsGained = 0;
    let pointBalance = 0;
    let usedBigTapEffective = false;
    let bigTapUsesToday = 0;

    // อ่านข้อมูลเดิมของ studentId
    const { data: existing, error: selectError } = await supabase
      .from('scores')
      .select('*')
      .eq('student_id', studentId)
      .maybeSingle();

    if (selectError) {
      console.error('select error:', selectError);
      return res
        .status(500)
        .json({ ok: false, message: 'อ่านฐานข้อมูลไม่สำเร็จ' });
    }

    let bestScore = taps;
    let totalXp = 0;
    let totalPlays = 0;
    let level = 1;
    let todayPlays = 1;
    let todayBest = taps;

    if (!existing) {
      // -------------------- ยังไม่เคยมี record -> insert ใหม่ --------------------
      xpMultiplier = 1;
      xpGain = taps * xpMultiplier;
      totalXp = xpGain;
      totalPlays = 1;
      level = calcLevel(totalXp);

      // ดรอปพอยท์เฉพาะเลเวล >= 3
      if (level >= 3) {
        const dropChance = 0.2; // 20%
        if (Math.random() < dropChance) {
          pointsGained = 1 + Math.floor(Math.random() * 3); // 1-3 พอยท์
        }
      }
      pointBalance = pointsGained; // เริ่มจาก 0 + ที่ดรอปได้
      bigTapUsesToday = 0;

      const { error: insertError } = await supabase.from('scores').insert({
        student_id: studentId,
        best_score: taps,
        wallet_address: walletAddress || null,
        total_xp: totalXp,
        total_plays: totalPlays,
        level: level,
        last_play_date: todayStr,
        today_plays: todayPlays,
        today_best: todayBest,
        point_balance: pointBalance,
        big_tap_uses_today: bigTapUsesToday,
        big_tap_last_date: todayStr
      });

      if (insertError) {
        console.error('insert error:', insertError);
        return res
          .status(500)
          .json({ ok: false, message: 'บันทึกคะแนนไม่สำเร็จ' });
      }
    } else {
      // -------------------- มี record อยู่แล้ว -> update --------------------
      const prevBest = existing.best_score || 0;
      bestScore = Math.max(prevBest, taps);

      const prevTotalXp = existing.total_xp || 0;
      const prevTotalPlays = existing.total_plays || 0;
      const prevLevel = existing.level || calcLevel(prevTotalXp);
      pointBalance = existing.point_balance || 0;

      let bigTapUses = existing.big_tap_uses_today || 0;
      const bigTapLastDate = existing.big_tap_last_date;

      // ตรวจเปลี่ยนวัน -> reset การใช้ BigTap วันนี้
      if (!bigTapLastDate || bigTapLastDate !== todayStr) {
        bigTapUses = 0;
      }

      // ใช้ Boost XP x2 ถ้า client ส่ง useBoost=true และพอยท์พอ
      useBoost = !!useBoost;
      if (useBoost && pointBalance >= 5) {
        xpMultiplier = 2;
        pointBalance -= 5; // หักพอยท์
        usedBoostEffective = true;
      } else {
        xpMultiplier = 1;
        usedBoostEffective = false;
      }

      // โหมด Big Tap (ปุ่มสี่เหลี่ยมเต็มพื้นที่): ใช้ 5 พอยท์ / ครั้ง, จำกัด 10 ครั้ง/วัน
      useBigTap = !!useBigTap;
      if (useBigTap && pointBalance >= 5 && bigTapUses < BIG_TAP_LIMIT) {
        pointBalance -= 5;
        bigTapUses += 1;
        usedBigTapEffective = true;
      }

      xpGain = taps * xpMultiplier;
      totalXp = prevTotalXp + xpGain;
      totalPlays = prevTotalPlays + 1;
      level = calcLevel(totalXp);

      let prevTodayPlays = existing.today_plays || 0;
      let prevTodayBest = existing.today_best || 0;
      const lastPlayDate = existing.last_play_date;

      // ถ้าเปลี่ยนวัน -> reset mission ของวันใหม่
      if (!lastPlayDate || lastPlayDate !== todayStr) {
        prevTodayPlays = 0;
        prevTodayBest = 0;
      }

      todayPlays = prevTodayPlays + 1;
      todayBest = Math.max(prevTodayBest, taps);
      bigTapUsesToday = bigTapUses;

      // ดรอปพอยท์เฉพาะเลเวล >= 3 (ใช้ level ใหม่หลังอัปเดต XP)
      if (level >= 3) {
        const dropChance = 0.2; // 20%
        if (Math.random() < dropChance) {
          pointsGained = 1 + Math.floor(Math.random() * 3); // 1-3 พอยท์แบบสุ่ม
          pointBalance += pointsGained;
        }
      }

      const updatePayload = {
        total_xp: totalXp,
        total_plays: totalPlays,
        level: level,
        last_play_date: todayStr,
        today_plays: todayPlays,
        today_best: todayBest,
        point_balance: pointBalance,
        big_tap_uses_today: bigTapUses,
        big_tap_last_date: todayStr
      };

      if (bestScore !== prevBest) {
        updatePayload.best_score = bestScore;
      }

      if (walletAddress) {
        updatePayload.wallet_address = walletAddress;
      }

      const { error: updateError } = await supabase
        .from('scores')
        .update(updatePayload)
        .eq('student_id', studentId);

      if (updateError) {
        console.error('update error:', updateError);
        return res
          .status(500)
          .json({ ok: false, message: 'อัปเดตคะแนนไม่สำเร็จ' });
      }
    }

    // คำนวณ badge จากข้อมูลล่าสุด
    const badges = calcBadges({
      total_plays: totalPlays,
      best_score: bestScore
    });

    // สถานะ mission วันนี้
    const played5Today = todayPlays >= 5;
    const got15Today = todayBest >= 15; // ถ้าอยากให้เป็น 10 เปลี่ยนเลขตรงนี้ได้

    return res.json({
      ok: true,
      bestScore,
      totalXp,
      level,
      totalPlays,
      badges,
      missions: {
        played5Today,
        got15Today,
        todayPlays,
        todayBest
      },
      pointBalance,
      pointsGained,
      usedBoost: usedBoostEffective,
      usedBigTap: usedBigTapEffective,
      bigTapUsesToday,
      bigTapLimit: BIG_TAP_LIMIT
    });
  } catch (err) {
    console.error(err);
    return res
      .status(500)
      .json({ ok: false, message: 'เกิดข้อผิดพลาดในเซิร์ฟเวอร์' });
  }
});

// ---------- API: Ranking ----------
app.get('/api/ranking', async (req, res) => {
  try {
    const { data, error } = await supabase
      .from('scores')
      .select('student_id, best_score, level')
      .order('best_score', { ascending: false })
      .limit(50);

    if (error) {
      console.error('ranking error:', error);
      return res
        .status(500)
        .json({ ok: false, message: 'โหลด Ranking ไม่สำเร็จ' });
    }

    const ranking = (data || []).map((row) => ({
      studentId: row.student_id,
      score: row.best_score,
      level: row.level || 1
    }));

    return res.json({ ok: true, ranking });
  } catch (err) {
    console.error(err);
    return res
      .status(500)
      .json({ ok: false, message: 'เกิดข้อผิดพลาดในเซิร์ฟเวอร์' });
  }
});

// ---------- API: Dashboard สรุป ----------
app.get('/api/admin/summary', async (req, res) => {
  try {
    const { data, error } = await supabase
      .from('scores')
      .select('best_score', { count: 'exact' });

    if (error) {
      console.error('summary error:', error);
      return res
        .status(500)
        .json({ ok: false, message: 'โหลดสรุปไม่สำเร็จ' });
    }

    const totalPlayers = data.length;
    if (totalPlayers === 0) {
      return res.json({
        ok: true,
        totalPlayers: 0,
        maxScore: 0,
        avgScore: 0
      });
    }

    let maxScore = 0;
    let sumScore = 0;
    data.forEach((row) => {
      const s = row.best_score || 0;
      if (s > maxScore) maxScore = s;
      sumScore += s;
    });
    const avgScore = sumScore / totalPlayers;

    return res.json({
      ok: true,
      totalPlayers,
      maxScore,
      avgScore
    });
  } catch (err) {
    console.error(err);
    return res
      .status(500)
      .json({ ok: false, message: 'เกิดข้อผิดพลาดในเซิร์ฟเวอร์' });
  }
});

app.listen(PORT, () => {
  console.log(`Tap Speed server running at http://localhost:${PORT}`);
});
