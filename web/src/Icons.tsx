// Іконки в стилі Tabler (MIT): контур 24×24, колір від тексту.
type P = { size?: number; className?: string };

function Svg({ size = 20, className, filled, children }: P & { filled?: boolean; children: React.ReactNode }) {
  return (
    <svg
      width={size}
      height={size}
      viewBox="0 0 24 24"
      fill={filled ? "currentColor" : "none"}
      stroke={filled ? "none" : "currentColor"}
      strokeWidth={2}
      strokeLinecap="round"
      strokeLinejoin="round"
      aria-hidden="true"
      className={className}
    >
      {children}
    </svg>
  );
}

export const Bolt = (p: P) => (
  <Svg {...p} filled>
    <path d="M13.2 2.4a.8.8 0 0 1 .8.8V9.5h5.2a.8.8 0 0 1 .65 1.27l-8 11a.8.8 0 0 1-1.45-.47V14.5H5.2a.8.8 0 0 1-.65-1.27l8-11a.8.8 0 0 1 .65-.33z" />
  </Svg>
);

export const BoltOff = (p: P) => (
  <Svg {...p}>
    <path d="M3 3l18 18" />
    <path d="M15.2 15.2L11 21v-7H5l3.8-5.2" />
    <path d="M10.6 5.5L13 3v7h6l-2.1 2.9" />
  </Svg>
);

export const WifiOff = (p: P) => (
  <Svg {...p}>
    <path d="M12 18h.01" />
    <path d="M9.17 15.17a4 4 0 0 1 5.66 0" />
    <path d="M6.34 12.34a8 8 0 0 1 3.87-2.14m4.16.16a8 8 0 0 1 3.29 2" />
    <path d="M3.52 9.52a12 12 0 0 1 3.54-2.46m3.1-.92a12 12 0 0 1 10.32 3.38" />
    <path d="M3 3l18 18" />
  </Svg>
);

export const Help = (p: P) => (
  <Svg {...p}>
    <path d="M12 21a9 9 0 1 0 0-18 9 9 0 0 0 0 18z" />
    <path d="M12 16v.01" />
    <path d="M12 13a2 2 0 0 0 .91-3.78 1.98 1.98 0 0 0-2.41.48" />
  </Svg>
);

export const Logout = (p: P) => (
  <Svg {...p}>
    <path d="M14 8V6a2 2 0 0 0-2-2H5a2 2 0 0 0-2 2v12a2 2 0 0 0 2 2h7a2 2 0 0 0 2-2v-2" />
    <path d="M9 12h12l-3-3" />
    <path d="M18 15l3-3" />
  </Svg>
);

export const ArrowUp = (p: P) => (
  <Svg {...p}>
    <path d="M12 19V5" />
    <path d="M18 11l-6-6-6 6" />
  </Svg>
);

export const ArrowDown = (p: P) => (
  <Svg {...p}>
    <path d="M12 5v14" />
    <path d="M18 13l-6 6-6-6" />
  </Svg>
);

export const Calendar = (p: P) => (
  <Svg {...p}>
    <path d="M4 7a2 2 0 0 1 2-2h12a2 2 0 0 1 2 2v12a2 2 0 0 1-2 2H6a2 2 0 0 1-2-2z" />
    <path d="M16 3v4M8 3v4M4 11h16" />
  </Svg>
);

export const Alert = (p: P) => (
  <Svg {...p}>
    <path d="M12 9v4M12 17h.01" />
    <path d="M10.36 3.6L2.4 17.3A1.9 1.9 0 0 0 4.04 20h15.92a1.9 1.9 0 0 0 1.64-2.7L13.64 3.6a1.9 1.9 0 0 0-3.28 0z" />
  </Svg>
);

export const Thermometer = (p: P) => (
  <Svg {...p}>
    <path d="M10 13.5a4 4 0 1 0 4 0V5a2 2 0 0 0-4 0z" />
    <path d="M10 9h4" />
  </Svg>
);

export const Sun = (p: P) => (
  <Svg {...p}>
    <path d="M8 12a4 4 0 1 0 8 0 4 4 0 1 0-8 0" />
    <path d="M3 12h1m8-9v1m8 8h1m-9 8v1M5.6 5.6l.7.7m12.1-.7l-.7.7m0 11.4l.7.7m-12.1-.7l-.7.7" />
  </Svg>
);

const CLOUD = "M7 18a4.6 4.4 0 0 1 0-9 5 4.5 0 0 1 11 2h1a3.5 3.5 0 0 1 0 7z";
const CLOUD_OPEN = "M7 16a4.6 4.4 0 0 1 0-9 5 4.5 0 0 1 11 2h1a3.5 3.5 0 0 1 0 7";

export const Cloud = (p: P) => (
  <Svg {...p}>
    <path d={CLOUD} />
  </Svg>
);

export const CloudRain = (p: P) => (
  <Svg {...p}>
    <path d={CLOUD_OPEN} />
    <path d="M9 17v2m0 2v.01M13 15v2m0 2v2m4-4v2" />
  </Svg>
);

export const CloudSnow = (p: P) => (
  <Svg {...p}>
    <path d={CLOUD_OPEN} />
    <path d="M9 17v.01M9 20.5v.01M13 15.5v.01M13 19v.01M17 17v.01M17 20.5v.01" />
  </Svg>
);

export const CloudStorm = (p: P) => (
  <Svg {...p}>
    <path d={CLOUD_OPEN} />
    <path d="M13 14l-2 4h3l-2 4" />
  </Svg>
);

export const Mist = (p: P) => (
  <Svg {...p}>
    <path d="M5 5h3m4 0h7M3 10h11m4 0h3M5 15h5m4 0h5M3 20h9m4 0h3" />
  </Svg>
);

/** Іконка погоди за кодом WMO: ясно, хмарно, туман, дощ, сніг або гроза. */
export function WeatherIcon({ code, ...p }: P & { code: number | null }) {
  if (code === null) return <Cloud {...p} />;
  if (code <= 1) return <Sun {...p} />;
  if (code <= 3) return <Cloud {...p} />;
  if (code === 45 || code === 48) return <Mist {...p} />;
  if ((code >= 71 && code <= 77) || code === 85 || code === 86) return <CloudSnow {...p} />;
  if (code >= 95) return <CloudStorm {...p} />;
  if (code >= 51) return <CloudRain {...p} />;
  return <Cloud {...p} />;
}
