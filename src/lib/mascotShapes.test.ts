import { describe, expect, it } from "vitest";
import { elementTransform } from "@/components/BlobAvatar";
import { MASCOT_SHAPES, mascotShape, resolveShape } from "./mascotShapes";

describe("mascot shapes", () => {
  it("keeps Blob first and uses supplied geometry", () => {
    expect(MASCOT_SHAPES[0]).toBe("blob");
    const blob = mascotShape("blob");
    expect(blob.fit).toBe("translate(-44.4052 -37.3374) scale(1.553736)");
    expect(blob.anchor).toEqual({ x: 116, y: 108, scale: 1.09 });
    expect(blob.body).toContain('fill="{{GRADIENT}}"');
    expect(blob.clip).not.toContain("{{GRADIENT}}");
  });

  // Kształty spoza zestawu ("wave", "gear", "shield") wracały jako surowy
  // kursor z fill="#000000" — maskotka wychodziła czarna.
  it("falls unknown names back to blob, keeping cursor and legacy shapes", () => {
    expect(resolveShape("wave")).toBe("blob");
    expect(resolveShape(null)).toBe("blob");
    expect(resolveShape("cursor")).toBe("cursor");
    expect(resolveShape("cloud")).toBe("cloud");
    expect(mascotShape("gear")).toEqual(mascotShape("blob"));
    expect(mascotShape("shield").body).toContain('fill="{{GRADIENT}}"');
  });

  // Pigułka, trójkąt i gwiazda mają mało miejsca na twarz w środku: przy
  // domyślnym 0.86 oczy siadały na krawędzi. Sylwetka rośnie o 7% (przez
  // `fit`, który NIE dotyczy twarzy), twarz maleje.
  it("gives pill, triangle and star a bigger body and a smaller face", () => {
    for (const name of ["pill", "triangle", "star"]) {
      const shape = mascotShape(name);
      expect(shape.fit, name).toBe("translate(-7.9989 -7.9989) scale(1.07)");
      expect(shape.anchor.scale, name).toBe(0.81);
    }
    // Reszta zestawu zostaje na domyślnych — zmiana miała dotknąć trzech.
    for (const name of ["circle", "square", "diamond", "leaf"]) {
      expect(mascotShape(name).fit, name).toBe("");
      expect(mascotShape(name).anchor.scale, name).toBe(0.86);
    }
  });

  // Teczka jest niesymetryczna: zakładka nad korpusem przesuwa środek bryły
  // w dół, więc twarz w środku pudełka lądowała na zgięciu.
  it("centres the folder face in its body, not in the box", () => {
    expect(mascotShape("folder").anchor).toEqual({ x: 114, y: 136, scale: 0.86 });
  });

  // Trzy kształty niosą `transform` NA SAMYM elemencie, osobno od `fit`.
  // Morf próbkuje surowe `d`, więc pominięcie go wysyłało kursor sto jednostek
  // poza kadr, a romb prostowało do kwadratu na czas przejścia.
  it("keeps the element transforms the morph has to compose", () => {
    expect(elementTransform(mascotShape("cursor").body)).toBe("translate(210,80)");
    expect(elementTransform(mascotShape("diamond").body)).toBe("rotate(45 114.2705 114.2705)");
    expect(elementTransform(mascotShape("cloud").body)).toBe("translate(0 -2)");
    // Reszta zestawu nie ma własnego transformu — cała geometria siedzi w `d`.
    for (const name of ["blob", "circle", "square", "pill", "triangle", "star", "folder", "leaf"]) {
      expect(elementTransform(mascotShape(name).body), name).toBe("");
    }
  });
});
