import { useEffect } from "react";

const SIZE = 64;

function drawFavicon(count: number, finished: boolean): string {
  const canvas = document.createElement("canvas");
  canvas.width = canvas.height = SIZE;
  const ctx = canvas.getContext("2d");
  if (!ctx) return "";
  ctx.fillStyle = "#12161c";
  ctx.beginPath();
  ctx.roundRect(2, 2, SIZE - 4, SIZE - 4, 14);
  ctx.fill();
  ctx.strokeStyle = count > 0 ? "#f4ae3d" : "#5ea5ff";
  ctx.lineWidth = 6;
  ctx.lineCap = "round";
  // Two patch-cable arcs, the mark of a switchboard.
  ctx.beginPath();
  ctx.moveTo(14, 44);
  ctx.bezierCurveTo(14, 18, 50, 18, 50, 44);
  ctx.stroke();
  ctx.fillStyle = ctx.strokeStyle;
  for (const x of [14, 50]) {
    ctx.beginPath();
    ctx.arc(x, 46, 6, 0, Math.PI * 2);
    ctx.fill();
  }
  if (count > 0) {
    ctx.fillStyle = "#f4ae3d";
    ctx.beginPath();
    ctx.arc(46, 18, 18, 0, Math.PI * 2);
    ctx.fill();
    ctx.fillStyle = "#10141a";
    ctx.font = "bold 26px sans-serif";
    ctx.textAlign = "center";
    ctx.textBaseline = "middle";
    ctx.fillText(count > 9 ? "9+" : String(count), 46, 19);
  }
  if (count === 0 && finished) {
    ctx.fillStyle = "#4fc08d";
    ctx.beginPath();
    ctx.arc(48, 16, 11, 0, Math.PI * 2);
    ctx.fill();
  }
  return canvas.toDataURL("image/png");
}

/** Mirrors the need-you count into the tab title and favicon (amber count, or a green dot for open finished items). */
export function useAttentionChrome(needsYou: number, hasFinished: boolean) {
  useEffect(() => {
    document.title = needsYou > 0 ? `(${needsYou}) Switchboard` : "Switchboard";
    let link = document.querySelector<HTMLLinkElement>("link[rel='icon']");
    if (!link) {
      link = document.createElement("link");
      link.rel = "icon";
      document.head.appendChild(link);
    }
    link.type = "image/png";
    link.href = drawFavicon(needsYou, hasFinished);
  }, [needsYou, hasFinished]);
}
