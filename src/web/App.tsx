// 顶层：Map 列表 / 打开的 Map（地址栏 ?map=<文件夹名>）；首次启动的隐私说明；设置；CLI 状态提示。
import { useEffect, useState } from "react";
import type { SettingsUpdate, StatusResponse } from "../server/api";
import { api } from "./client";
import { MapList, PrivacyNotice, Settings } from "./Home";
import { MapView } from "./MapView";

const mapFromUrl = () => new URLSearchParams(location.search).get("map");

export function App() {
  const [status, setStatus] = useState<StatusResponse | null>(null);
  const [statusError, setStatusError] = useState<string | null>(null);
  const [map, setMap] = useState<string | null>(mapFromUrl);
  const [showPrivacy, setShowPrivacy] = useState(false);
  const [showSettings, setShowSettings] = useState(false);

  const loadStatus = async (refresh = false) => {
    try {
      const s = await api.status(refresh);
      setStatus(s);
      setStatusError(null);
      // CLI 检测需要几秒：还没结果时稍后再问一次
      if (!s.provider) setTimeout(() => void loadStatus(), 1500);
      return s;
    } catch (e) {
      setStatusError((e as Error).message);
      return null;
    }
  };

  useEffect(() => {
    void loadStatus().then((s) => s && !s.config.privacy_notice_seen && setShowPrivacy(true));
    const onPop = () => setMap(mapFromUrl());
    window.addEventListener("popstate", onPop);
    return () => window.removeEventListener("popstate", onPop);
  }, []);

  const open = (name: string | null) => {
    history.pushState(null, "", name ? `?map=${encodeURIComponent(name)}` : location.pathname);
    setMap(name);
  };
  const changeSettings = async (s: SettingsUpdate) => {
    const config = await api.saveSettings(s);
    setStatus((st) => (st ? { ...st, config } : st));
  };

  if (statusError) return <p className="warn home">⚠ {statusError}</p>;
  if (!status) return <p className="hint home">连接中…</p>;

  const p = status.provider;
  return (
    <>
      {p && !p.ok && <div className="notice warn">⚠ {p.message}</div>}
      {p?.apiKeyEnvSet && (
        <div className="notice">
          检测到环境变量 ANTHROPIC_API_KEY：Think 调用 CLI 时会把它从子进程环境中移除，以使用你的订阅登录（不会按 API 计费）。
        </div>
      )}
      {map ? (
        <MapView key={map} name={map} config={status.config} onBack={() => open(null)} onSettings={() => setShowSettings(true)} />
      ) : (
        <div className="app">
          <header>
            <h1>Think</h1>
            <span className="meta">{p ? p.message : "正在检测 Claude Code…"}</span>
            <div className="spacer" />
            <button onClick={() => setShowSettings(true)}>⚙ 设置</button>
          </header>
          <MapList onOpen={open} />
        </div>
      )}
      {showSettings && (
        <Settings
          status={status}
          onChange={changeSettings}
          onRecheck={() => void loadStatus(true)}
          onShowPrivacy={() => {
            setShowSettings(false);
            setShowPrivacy(true);
          }}
          onClose={() => setShowSettings(false)}
        />
      )}
      {showPrivacy && (
        <PrivacyNotice
          status={status}
          onClose={() => {
            setShowPrivacy(false);
            if (!status.config.privacy_notice_seen) void changeSettings({ privacy_notice_seen: true });
          }}
        />
      )}
    </>
  );
}
