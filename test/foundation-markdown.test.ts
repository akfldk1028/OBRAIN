import { describe, expect, it } from "vitest";
import { BRAIN_FOUNDATION_POLICY } from "../src/foundation/policy.js";
import {
  renderAreaGuide,
  renderAreaMoc,
  renderHomeMoc,
  renderRootGuide,
} from "../src/foundation/markdown.js";

describe("foundation Markdown", () => {
  it("teaches every AI the required reading and writing rules", () => {
    const guide = renderRootGuide(BRAIN_FOUNDATION_POLICY);

    expect(guide).toContain("policy_version: 1.0.0");
    expect(guide).toContain("1. `000_AI_WORK_GUIDE.md`");
    expect(guide).toContain("Agent-Inbox");
    expect(guide).toContain("> [!abstract] 한눈에 보기");
    expect(guide).toContain("원문을 그대로 보존");
    expect(guide).toContain("최대 5레벨");
    for (const heading of [
      "## Vault 전체 구조", "## MOC 규칙", "## 수식 설명 순서", "## PDF와 논문",
      "## 태그", "## 링크와 Canvas", "## 자동 정리", "## 사용자 선호", "## 작업 체크리스트",
    ]) {
      expect(guide).toContain(heading);
    }
    expect(guide).toMatch(/#AI가이드 #인수인계 #시스템 #범용\n$/);
  });

  it("links Home to every area MOC and reserves one managed block", () => {
    const home = renderHomeMoc(BRAIN_FOUNDATION_POLICY);

    for (const area of BRAIN_FOUNDATION_POLICY.areas) {
      expect(home).toContain(`[[${area.directory}/000_${area.slug}_MOC]]`);
    }
    expect(home.match(/brain-auto:start note-index/g)).toHaveLength(1);
    expect(home.match(/brain-auto:end note-index/g)).toHaveLength(1);
  });

  it("creates an area MOC with a protected human section and managed index", () => {
    const study = renderAreaMoc(BRAIN_FOUNDATION_POLICY.areas[3]);

    expect(study).toContain("# 📚 Study MOC");
    expect(study).toContain("## 사람이 작성하는 설명");
    expect(study).toContain("<!-- brain-auto:start note-index -->");
    expect(study).toContain("[[000_Home_MOC]]");
  });

  it("adds the Study citation and formula-order workflow to its area guide", () => {
    const guide = renderAreaGuide(BRAIN_FOUNDATION_POLICY.areas[3]);

    expect(guide).toContain("인용");
    expect(guide).toContain("일상 비유 → 중학생 직관 → 수식 → 기호표 → 단계별 이유");
  });

  it.each([
    ["Research", "연구 질문, 방법, 근거, 한계, 인사이트"],
    ["Project", "목표, 상태, 결정, 결과물, 다음 행동"],
    ["Development", "환경, 재현 방법, 변경, 테스트, 롤백"],
    ["Tools", "설정 목적, 의존성, 검증, 복구"],
  ])("adds the %s workflow to its area guide", (slug, requiredContent) => {
    const area = BRAIN_FOUNDATION_POLICY.areas.find((candidate) => candidate.slug === slug);
    if (!area) throw new Error(`Missing policy area: ${slug}`);

    expect(renderAreaGuide(area)).toContain(requiredContent);
  });

  it("keeps secret values out of the Tools workflow", () => {
    const tools = BRAIN_FOUNDATION_POLICY.areas.find((area) => area.slug === "Tools");
    if (!tools) throw new Error("Missing policy area: Tools");

    expect(renderAreaGuide(tools)).toContain("비밀 값은 절대 기록하지 않습니다");
  });

  it("gives non-specialized areas their inherited root contract and purpose", () => {
    const prompt = BRAIN_FOUNDATION_POLICY.areas[0];
    const guide = renderAreaGuide(prompt);

    expect(guide).toContain("루트 가이드의 전체 계약을 그대로 따릅니다");
    expect(guide).toContain(prompt.purpose);
  });
});
