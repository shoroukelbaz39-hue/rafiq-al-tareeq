import { createFileRoute } from "@tanstack/react-router";
import { BellRing, AlertTriangle, ScreenShare, Coins, HeartHandshake, MapPin, Navigation, Radar, Square, Volume2 } from "lucide-react";
import { useEffect, useRef, useState } from "react";
import { toast } from "sonner";
import { AdSlot } from "@/components/app/AdSlot";
import { Field, selectClass } from "@/components/app/Field";
import { PageHeader } from "@/components/app/PageHeader";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { changeDue } from "@/lib/ads";
import { startAlarmLoop, stopAlarmLoop, testAlarm } from "@/lib/alarm";
import { keepAliveActive, startKeepAlive, stopKeepAlive } from "@/lib/keepalive";
import { acquireWakeLock, releaseWakeLock, wakeLockSupported } from "@/lib/wake-lock";
import { geocode, getCached, MIN_QUERY_LENGTH, type GeoResult } from "@/lib/geocode";
import { clearTrip, evaluatePosition, loadTrip, saveTrip, type TripEvent } from "@/lib/trip-state";
import { batteryWarning } from "@/lib/battery";
import { formatFare, normalizeArabic, toArabicDigits } from "@/lib/arabic";
import { PLACES, type Place } from "@/lib/geo";
import { pageHead } from "@/lib/seo";
import { useSettings } from "@/lib/settings";
import { getCurrentCoords, mapsLink, smsLink, whatsappLink } from "@/lib/sos";

export const Route = createFileRoute("/trip")({
  head: () => pageHead("رحلتي", "منبه الوجهة بالـ GPS، رادار المعالم، زر وصلت بالسلامة، وحاسبة الفكة."),
  component: TripPage,
});

async function notify(title: string, body: string, loud = false) {
  toast(title, { description: body, duration: 8000 });
  if ("vibrate" in navigator) navigator.vibrate?.(loud ? [600, 200, 600, 200, 900] : [300, 150, 300]);
  if ("Notification" in window && Notification.permission === "granted") {
    const opts = { body, icon: "/icons/icon-192.png", tag: "rafiq-trip", requireInteraction: loud, vibrate: [600, 200, 600] } as NotificationOptions;
    try {
      // A service-worker notification can show even when the page is in the background (Android).
      const reg = "serviceWorker" in navigator ? await navigator.serviceWorker.getRegistration() : undefined;
      if (reg) await reg.showNotification(title, opts);
      else new Notification(title, opts);
    } catch { try { new Notification(title, { body }); } catch { /* ignore */ } }
  }
}

function TripPage() {
  const [s] = useSettings();
  const [destName, setDestName] = useState(PLACES[0]!.name);
  const [customText, setCustomText] = useState("");
  const [custom, setCustom] = useState<Place | null>(null);
  const [watching, setWatching] = useState(false);
  const [km, setKm] = useState<number | null>(null);
  const [nearby, setNearby] = useState<string[]>([]);
  const watchId = useRef<number | null>(null);
  const fired = useRef<Set<string>>(new Set());
  const trip = useRef<{ dest: Place; startedAt: number } | null>(null);
  const lastFix = useRef(0);
  const [alarm, setAlarm] = useState<TripEvent | null>(null);
  const [wakeOn, setWakeOn] = useState(true);
  const [wakeHeld, setWakeHeld] = useState(false);
  const [resumed, setResumed] = useState(false);
  const [bgOn, setBgOn] = useState(false);
  const [lastFixAt, setLastFixAt] = useState<number | null>(null);
  const [tick, setTick] = useState(0);
  useEffect(() => { if (!watching) return; const i = setInterval(() => setTick((x) => x + 1), 15000); return () => clearInterval(i); }, [watching]);
  // Detected after mount: reading `navigator` while rendering differs between server and phone (hydration error).
  const [wakeSupported, setWakeSupported] = useState(true);
  useEffect(() => { setWakeSupported(wakeLockSupported()); }, []);
  // Free-text destination: matches a known place when possible (GPS alarm keeps working),
  // otherwise keeps the typed name for the arrival message while the distance alarm stays off.
  const typed = customText.trim();
  // matchedPlace: what she typed is (part of) a known place name, so no lookup is needed.
  // containedPlace: she typed MORE than a known name (e.g. "جامعة الزقازيق كلية الهندسة"): look it up
  // precisely on the map, and only fall back to the known place if the lookup fails.
  const nTyped = normalizeArabic(typed);
  const matchedPlace = typed.length >= MIN_QUERY_LENGTH ? PLACES.find((p) => normalizeArabic(p.name).includes(nTyped)) : undefined;
  const containedPlace = typed.length >= MIN_QUERY_LENGTH && !matchedPlace ? PLACES.find((p) => nTyped.includes(normalizeArabic(p.name))) : undefined;
  // Not a known place: look it up on OpenStreetMap so the distance alarm works for any typed place.
  const needsLookup = !!typed && !matchedPlace && typed.length >= MIN_QUERY_LENGTH;
  const [geo, setGeo] = useState<{ status: "idle" | "loading" | "ok" | "none" | "error"; results: GeoResult[] }>({ status: "idle", results: [] });
  const [pick, setPick] = useState(0);
  useEffect(() => {
    setPick(0);
    if (!needsLookup) { setGeo({ status: "idle", results: [] }); return; }
    const hit = getCached(typed);
    if (hit) { setGeo({ status: "ok", results: hit }); return; }
    setGeo({ status: "loading", results: [] });
    const ctl = new AbortController();
    // Debounce: Nominatim allows 1 request/second and forbids per-keystroke lookups.
    const t = setTimeout(() => {
      void geocode(typed, { signal: ctl.signal }).then((r) => {
        if (ctl.signal.aborted) return;
        setGeo(r.status === "ok" ? { status: "ok", results: r.results } : { status: r.status, results: [] });
      });
    }, 1000);
    return () => { clearTimeout(t); ctl.abort(); };
  }, [typed, needsLookup]);
  const resolved = geo.status === "ok" ? geo.results[pick] ?? geo.results[0] : undefined;
  const lookupFailed = geo.status === "error" || geo.status === "none";
  const typedDest: Place | null = typed
    ? (matchedPlace ?? (resolved ? { name: typed, lat: resolved.lat, lng: resolved.lng, kind: "landmark" } : lookupFailed && containedPlace ? { ...containedPlace, name: typed } : { name: typed, lat: Number.NaN, lng: Number.NaN, kind: "landmark" }))
    : null;
  const dest = custom ?? typedDest ?? PLACES.find((p) => p.name === destName) ?? PLACES[0]!;
  const destHasCoords = Number.isFinite(dest.lat) && Number.isFinite(dest.lng);

  const persist = (wake = wakeOn) => {
    if (trip.current) saveTrip({ dest: trip.current.dest, startedAt: trip.current.startedAt, fired: [...fired.current], wakeLock: wake });
  };

  const handleFix = (here: { lat: number; lng: number }) => {
    const t = trip.current;
    if (!t) return;
    lastFix.current = Date.now();
    setLastFixAt(lastFix.current);
    const r = evaluatePosition(here, t.dest, fired.current, PLACES, toArabicDigits);
    if (r.km != null) setKm(r.km);
    setNearby(r.nearby);
    for (const ev of r.events) {
      fired.current.add(ev.key);
      if (ev.kind === "arrived") fired.current.add("near");
      void notify(ev.title, ev.body, ev.loud);
      if (ev.loud) { setAlarm(ev); startAlarmLoop(); }
    }
    if (r.events.length) persist();
  };

  const stop = (forget = true) => {
    if (watchId.current != null) navigator.geolocation?.clearWatch(watchId.current);
    watchId.current = null; setWatching(false);
    void releaseWakeLock(); setWakeHeld(false);
    stopKeepAlive(); setBgOn(false);
    if (forget) { clearTrip(); trip.current = null; }
  };
  // Leaving the page keeps the saved trip (so it resumes); only the live watcher is released.
  useEffect(() => () => { stop(false); stopAlarmLoop(); }, []);

  const begin = (d: Place, startedAt: number, wake: boolean) => {
    trip.current = { dest: d, startedAt };
    lastFix.current = Date.now();
    setWatching(true);
    persist(wake);
    if (wake) void acquireWakeLock().then(setWakeHeld);
    watchId.current = navigator.geolocation.watchPosition(
      (pos) => handleFix({ lat: pos.coords.latitude, lng: pos.coords.longitude }),
      (err) => {
        if (err.code === 1) { toast.error("فعّل خدمة الموقع (GPS) للمتابعة"); stop(); }
        else toast.warning("إشارة الموقع ضعيفة حالياً، هنكمل المحاولة", { duration: 5000 });
      },
      { enableHighAccuracy: true, maximumAge: 10000, timeout: 60000 },
    );
  };

  const start = async () => {
    if (!navigator.geolocation) { toast.error("الجهاز لا يدعم تحديد الموقع"); return; }
    if ("Notification" in window && Notification.permission === "default") await Notification.requestPermission().catch(() => {});
    if (s.batteryWarn) {
      const w = await batteryWarning();
      if (w) toast.warning(w, { duration: 9000 });
    }
    if (!destHasCoords) {
      toast("«" + dest.name + "» مش على الخريطة عندنا، فالتنبيه بالمسافة مش هيعرف يقيسها. رادار المعالم ورسالة «وصلت بالسلامة» شغالين عادي، وتقدر تختار أقرب مكان معروف من القايمة لو عايز المنبه.", { duration: 9000 });
    }
    if (!wakeSupported) toast.warning("المتصفح ده مش بيدعم إبقاء الشاشة مفتوحة، فلازم تسيب الشاشة مفتوحة بنفسك عشان المنبه يشتغل.", { duration: 9000 });
    fired.current = new Set();
    setResumed(false);
    begin(dest, Date.now(), wakeOn);
    // From the tap: audio is only allowed after a gesture. Best effort, see lib/keepalive.ts.
    void startKeepAlive(dest.name, () => setBgOn(false)).then(setBgOn);
  };

  // Reopen the app: pick the saved trip up again instead of silently forgetting it.
  useEffect(() => {
    const saved = loadTrip();
    if (!saved || !navigator.geolocation) return;
    fired.current = new Set(saved.fired);
    setCustom(saved.dest);
    setWakeOn(saved.wakeLock);
    setResumed(true);
    begin(saved.dest, saved.startedAt, saved.wakeLock);
    navigator.geolocation.getCurrentPosition((p) => handleFix({ lat: p.coords.latitude, lng: p.coords.longitude }), () => {}, { enableHighAccuracy: true, timeout: 20000 });
    toast("كملنا متابعة رحلتك لـ " + saved.dest.name, { duration: 6000 });
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  // Coming back to the screen: the browser pauses GPS and drops the wake lock while hidden.
  useEffect(() => {
    const onVisible = () => {
      if (document.visibilityState !== "visible" || !trip.current) return;
      if (wakeOn) void acquireWakeLock().then(setWakeHeld);
      setBgOn(keepAliveActive());
      const gap = Date.now() - lastFix.current;
      if (gap > 90_000) toast.warning("المتابعة كانت واقفة حوالي " + toArabicDigits(String(Math.round(gap / 60000))) + " دقيقة لأن الشاشة كانت مقفولة. بنفحص مكانك دلوقتي.", { duration: 9000 });
      navigator.geolocation?.getCurrentPosition((p) => handleFix({ lat: p.coords.latitude, lng: p.coords.longitude }), () => {}, { enableHighAccuracy: true, timeout: 20000 });
    };
    document.addEventListener("visibilitychange", onVisible);
    return () => document.removeEventListener("visibilitychange", onVisible);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [wakeOn]);

  const toggleWake = async () => {
    const next = !wakeOn;
    setWakeOn(next);
    if (watching) {
      persist(next);
      if (next) setWakeHeld(await acquireWakeLock()); else { await releaseWakeLock(); setWakeHeld(false); }
    }
  };

  const dismissAlarm = () => {
    stopAlarmLoop();
    const was = alarm;
    setAlarm(null);
    if (was?.kind === "arrived") stop();
  };

  const saveHere = async () => {
    const c = await getCurrentCoords();
    if (!c) { toast.error("تعذّر تحديد الموقع"); return; }
    setCustom({ name: "مكان حفظته", lat: c.lat, lng: c.lng, kind: "landmark" });
    toast.success("تم حفظ موقعك الحالي كوجهة");
  };

  const arrived = async (via: "sms" | "wa") => {
    if (!s.emergencyNumber) { toast.error("سجّل رقم الطوارئ من الإعدادات"); return; }
    const c = await getCurrentCoords(8000);
    const body = `الحمد لله ${s.userName ? `(${s.userName}) ` : ""}وصلت ${dest?.name ?? "وجهتي"} بالسلامة 🤍${c ? `\nموقعي: ${mapsLink(c)}` : ""}\n— رفيق الطريق`;
    window.location.href = via === "sms" ? smsLink(s.emergencyNumber, body) : whatsappLink(s.emergencyNumber, body);
  };

  const [paid, setPaid] = useState("100");
  const [fare, setFare] = useState("10");
  const [people, setPeople] = useState("1");
  const rest = changeDue(Number(paid) || 0, Number(fare) || 0, Number(people) || 1);

  return (
    <div className="space-y-5">
      {alarm && (
        <div role="alertdialog" aria-live="assertive" className="fixed inset-0 z-[100] flex animate-pulse flex-col items-center justify-center gap-6 bg-sos p-6 text-center text-white">
          <BellRing className="size-24" />
          <h2 className="text-4xl font-extrabold">{alarm.title}</h2>
          <p className="text-xl font-bold">{alarm.body}</p>
          <Button onClick={dismissAlarm} className="h-16 w-full max-w-sm bg-white text-xl font-extrabold text-sos hover:bg-white/90">إيقاف المنبه</Button>
        </div>
      )}
      <PageHeader title="رحلتي" subtitle="منبه الوجهة وأمان المشوار" icon={Navigation} tone="road" />

      <section className="space-y-4 rounded-3xl border border-border bg-card p-5 shadow-soft">
        <h2 className="flex items-center gap-2 font-bold"><BellRing className="size-5 text-road" /> منبه الوجهة</h2>
        <Field label="رايح فين؟">
          <select value={custom || typed ? "" : destName} onChange={(e) => { setCustom(null); setCustomText(""); setDestName(e.target.value); }} className={selectClass} disabled={watching}>
            {(custom || typed) && <option value="">{dest.name}</option>}
            {PLACES.map((p) => <option key={p.name}>{p.name}</option>)}
          </select>
        </Field>
        <Field label="أو اكتب وجهتك بنفسك">
          <Input
            value={customText}
            onChange={(e) => { setCustom(null); setCustomText(e.target.value); }}
            placeholder="مثلاً: ميدان الساعة، كفر الشيخ، شغلي…"
            className="h-11"
            disabled={watching}
          />
        </Field>
        {typed && (
          <div className="space-y-2 text-xs text-muted-foreground">
            {matchedPlace && <p>{`هننبهك بالمسافة لأقرب نقطة معروفة: ${matchedPlace.name} ✅`}</p>}
            {!matchedPlace && !needsLookup && <p>اكتب ٣ حروف على الأقل عشان نلاقي المكان.</p>}
            {needsLookup && geo.status === "loading" && <p>بندوّر على «{typed}» على الخريطة…</p>}
            {needsLookup && geo.status === "ok" && (
              <div className="space-y-1.5 rounded-2xl bg-road-soft p-3 text-foreground">
                <p className="font-bold text-road">لقينا المكان ✅ اتأكد إنه ده اللي تقصده:</p>
                {geo.results.map((r, i) => (
                  <label key={`${r.lat},${r.lng}`} className="flex cursor-pointer items-start gap-2">
                    <input type="radio" name="geo-pick" checked={i === pick} onChange={() => setPick(i)} disabled={watching} className="mt-1" />
                    <span>{r.name}</span>
                  </label>
                ))}
                <p className="text-muted-foreground">لو مش ده المكان، اختار غيره أو اكتب الاسم بشكل أوضح (مثلاً زوّد اسم المدينة).</p>
              </div>
            )}
            {needsLookup && lookupFailed && containedPlace && <p className="font-bold text-road">{`هننبهك بالمسافة لأقرب نقطة معروفة: ${containedPlace.name} ✅`}</p>}
            {needsLookup && geo.status === "none" && <p>مالقيناش «{typed}» على الخريطة. جرّب كتابة أوضح (مع اسم المدينة) أو اختار من القايمة.</p>}
            {needsLookup && geo.status === "error" && <p className="font-bold text-sos">مقدرناش نبحث عن المكان لأن مفيش اتصال بالإنترنت دلوقتي. اختار أقرب مكان من القايمة، أو جرّب تاني لما النت يرجع.</p>}
          </div>
        )}
        <Button variant="outline" size="sm" onClick={saveHere} disabled={watching}><MapPin /> احفظ مكاني الحالي كوجهة للرجوع</Button>
        <Button variant="outline" size="sm" onClick={testAlarm}><Volume2 /> جرّب نغمة المنبه القوية</Button>
        {watching ? (
          <Button onClick={() => stop()} variant="destructive" className="h-12 w-full"><Square /> إيقاف المتابعة</Button>
        ) : (
          <Button onClick={start} disabled={needsLookup && geo.status === "loading"} className="h-12 w-full"><Navigation /> ابدأ المتابعة</Button>
        )}
        {km != null && (
          <p className="rounded-2xl bg-road-soft p-3 text-center font-bold text-road">
            المسافة المتبقية: {toArabicDigits(km.toFixed(1))} كم
          </p>
        )}
        <p className="text-xs text-muted-foreground">هننبهك قبل الوصول بـ ٣ كم وعند الوصول.</p>
        {watching && (
          <p className="rounded-2xl bg-road-soft p-3 text-xs text-foreground" data-tick={tick}>
            آخر تحديث للموقع: {lastFixAt ? "من " + toArabicDigits(String(Math.max(0, Math.round((Date.now() - lastFixAt) / 1000)))) + " ثانية" : "لسه مجاش"}.
            {" "}وضع التشغيل مع قفل الشاشة (تجريبي): {bgOn ? "شغّال، هيظهر إشعار «المتابعة شغالة». لو ظهر إشعار صوت، سيبه." : "مش شغّال على الجهاز ده، سيب الشاشة مفتوحة."}
          </p>
        )}
        {resumed && watching && <p className="rounded-2xl bg-road-soft p-3 text-xs font-bold text-road">كملنا متابعة رحلتك المحفوظة لـ {dest.name}. المتابعة مش بتتلغي لو قفلت التطبيق وفتحته تاني.</p>}
        <button type="button" onClick={() => void toggleWake()} className="flex w-full items-center justify-between rounded-2xl border border-border p-3 text-sm">
          <span className="flex items-center gap-2 font-bold"><ScreenShare className="size-4" /> إبقاء الشاشة مفتوحة أثناء الرحلة</span>
          <span className={wakeOn ? "font-bold text-success" : "text-muted-foreground"}>{wakeOn ? (watching ? (wakeHeld ? "شغّال ✅" : "جاري التفعيل…") : "مفعّل") : "مقفول"}</span>
        </button>
        <div className="flex gap-2 rounded-2xl bg-gold/10 p-3 text-xs leading-relaxed text-foreground">
          <AlertTriangle className="mt-0.5 size-4 shrink-0 text-gold" />
          <p>
            تنبيه مهم: التطبيق ده بيشتغل من المتصفح، والمتصفح بيوقف تحديد الموقع لما الشاشة تتقفل أو تفتح تطبيق تاني. عشان المنبه يرن: سيب التطبيق مفتوح على الشاشة دي، وخلي «إبقاء الشاشة مفتوحة» شغّال، واسمح بالإشعارات والموقع، وارفع الصوت. لو قفلت الشاشة، التتبع ممكن يقف لحد ما تفتحها تاني (هنكمله ونفحص مكانك فوراً).
            {!wakeSupported && " المتصفح ده مش بيدعم إبقاء الشاشة مفتوحة، فخلي الشاشة شغالة بنفسك."}
          </p>
        </div>
      </section>

      <section className="space-y-2 rounded-3xl border border-border bg-card p-5 shadow-soft">
        <h2 className="flex items-center gap-2 font-bold"><Radar className="size-5 text-anis" /> رادار المعالم</h2>
        {nearby.length ? nearby.map((n) => <p key={n} className="text-sm">📍 {n}</p>) : <p className="text-sm text-muted-foreground">ابدأ المتابعة وهنعرّفك بالأماكن المشهورة اللي بتعدي جنبها.</p>}
      </section>

      <section className="space-y-3 rounded-3xl border border-success/30 bg-success-soft p-5">
        <h2 className="flex items-center gap-2 font-bold text-success"><HeartHandshake className="size-5" /> وصلت بالسلامة</h2>
        <p className="text-sm text-muted-foreground">طمّن {s.emergencyName || "أهلك"} برسالة واحدة فيها موقعك.</p>
        <div className="grid grid-cols-2 gap-2">
          <Button onClick={() => void arrived("wa")} className="h-12">واتساب</Button>
          <Button onClick={() => void arrived("sms")} variant="outline" className="h-12">رسالة SMS</Button>
        </div>
      </section>

      <section className="space-y-3 rounded-3xl border border-border bg-card p-5 shadow-soft">
        <h2 className="flex items-center gap-2 font-bold"><Coins className="size-5 text-gold" /> حاسبة الفكة</h2>
        <div className="grid grid-cols-3 gap-2">
          <Field label="معاك"><Input value={paid} onChange={(e) => setPaid(e.target.value)} inputMode="decimal" className="h-11" /></Field>
          <Field label="الأجرة"><Input value={fare} onChange={(e) => setFare(e.target.value)} inputMode="decimal" className="h-11" /></Field>
          <Field label="الركاب"><Input value={people} onChange={(e) => setPeople(e.target.value)} inputMode="numeric" className="h-11" /></Field>
        </div>
        <p className={rest >= 0 ? "rounded-2xl bg-primary-soft p-3 text-center font-bold text-primary" : "rounded-2xl bg-sos-soft p-3 text-center font-bold text-sos"}>
          {rest >= 0 ? `الباقي لك: ${formatFare(rest)}` : `ناقصك: ${formatFare(-rest)}`}
        </p>
        <AdSlot dest={dest.name} area={s.governorate} />
      </section>
    </div>
  );
}
