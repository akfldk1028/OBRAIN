import type { AreaDefinition, VaultFoundationPolicy } from "./policy.js";

const managedBlock = [
  "<!-- brain-auto:start note-index -->",
  "<!-- brain-auto:end note-index -->",
].join("\n");

const joinMarkdown = (lines: readonly string[]) => lines.join("\n") + "\n";

export function renderRootGuide(policy: VaultFoundationPolicy): string {
  const areas = policy.areas.map((area) =>
    "- `" + area.directory + "` — " + area.purpose,
  );

  return joinMarkdown([
    "---", "policy_version: " + policy.version, "type: ai-work-guide", "---", "",
    "# 🤖 AI 작업 가이드", "",
    "> [!abstract] 목적", "> 모든 AI가 같은 폴더·노트·링크 규칙을 사용합니다.", "",
    "## 작업 전 읽기 순서", "",
    "1. `" + policy.rootGuide + "`",
    "2. `" + policy.homeMoc + "`",
    "3. 작업 폴더의 `99_작업가이드_다음AI용.md`",
    "4. 작업 폴더의 `000_*_MOC.md`", "",
    "## 필수 안전 규칙", "",
    "- 새 AI 노트는 먼저 `" + policy.inbox + "`에 생성합니다.",
    "- 폴더는 최대 " + policy.maxDepth + "레벨입니다.",
    "- 기존 파일을 덮어쓰거나 영구 삭제하지 않습니다.",
    "- 비밀번호, API 키, SSH 키, 토큰은 노트에 기록하지 않습니다.",
    "- 자동 정리 시 사용자의 원문을 그대로 보존합니다.", "",
    "## Vault 전체 구조", "",
    "로컬 Vault 경로는 `D:/obsidian/Brain/`입니다. 최상위 영역은 아래 열 가지이며, 새 폴더는 최대 " + policy.maxDepth + "레벨까지만 만듭니다. AI가 만든 초안은 항상 `" + policy.inbox + "`에서 시작합니다.",
    "", ...areas, "",
    "## MOC 규칙", "",
    "- 각 영역에는 반드시 `000_*_MOC.md`가 하나 있어야 합니다.",
    "- 하위 노트는 위쪽 MOC를 링크해 탐색 경로를 유지합니다.",
    "- `<!-- brain-auto:start note-index -->`와 `<!-- brain-auto:end note-index -->` 사이의 바이트는 자동화만 관리합니다.",
    "- 사람의 설명과 원문은 자동화가 수정하지 않습니다.", "",
    "## 노트 작성 규칙", "",
    "- `[!abstract]`: 한눈에 보는 쉬운 요약",
    "- `[!example]`: 일상적인 예시와 비유",
    "- `[!note]`: 추가 배경과 헷갈리기 쉬운 설명",
    "- `[!tip]`: 기억할 핵심과 실전 팁",
    "- `[!warning]`: 한계, 위험, 주의할 점",
    "- `[!info]`: 사실, 출처, 참고 정보",
    "- `[!success]`: 확인된 결과와 완료 조건", "",
    "## 기본 노트 표현", "",
    "> [!abstract] 한눈에 보기", "> 쉬운 요약", "",
    "> [!example] 쉬운 비유", "> 일상적인 예시", "",
    "> [!note] 추가 설명", "> 헷갈리는 부분", "",
    "> [!tip] 기억할 핵심", "> 결론", "",
    "> [!warning] 주의할 점", "> 한계와 위험", "",
    "## 수식 설명 순서", "",
    "수식은 반드시 일상 비유 → 중학생 직관 → 수식 → 기호표 → 단계별 이유 순서로 설명합니다. 기호표에는 각 기호의 뜻과 단위를 쓰고, 단계별 이유에서는 식이 왜 그렇게 변하는지 말로 풀어 씁니다.", "",
    "## PDF와 논문", "",
    "- 원본 제목, 섹션, 페이지 범위를 기록합니다.",
    "- 주제별 노트는 번호를 붙여 나누고, 마스터 노트에서 필요한 노트를 임베드합니다.",
    "- 각 주제 노트에는 시험 질문과 `활용 인사이트`를 남깁니다.",
    "- 인용은 원문 위치로 되돌아갈 수 있는 링크와 함께 보존합니다.", "",
    "## 태그", "",
    "공식 태그는 `#MOC`, `#학습`, `#논문`, `#프로젝트`, `#RL`, `#CV`, `#NLP`, `#Unity`입니다. 태그는 검색을 돕는 최소한의 분류로만 사용합니다.", "",
    "## 링크와 Canvas", "",
    "- 위키링크: `[[노트]]`, 제목 링크: `[[노트#제목]]`, 블록 링크: `[[노트#^block-id]]`, 임베드: `![[노트]]`를 사용합니다.",
    "- 링크 의미는 상위(parent), 관련(related), 선행(prerequisite), 후속(next), 근거(evidence), 적용(applies-to), 결과물(produces), 충돌(contradicts) 중 실제 관계만 기록합니다.",
    "- Canvas에는 탐색을 돕는 핵심 노드와 검증된 관계만 추가합니다.",
    "- Markdown은 source of truth이고, Canvas는 사람이 보는 generated visualization입니다.",
    "- AI가 관리하는 Canvas 파일은 `000_*_Map.canvas`뿐입니다. 그 밖의 모든 Canvas 파일은 사람이 관리합니다.", "",
    "## 자동 정리", "",
    "1. 새 내용은 `" + policy.inbox + "`에 작성합니다.",
    "2. 비밀정보를 검사합니다.",
    "3. 이동·연결·태그 변경을 제안합니다.",
    "4. 링크, 경로, 중복을 검증합니다.",
    "5. 신뢰도 높음·중간·낮음 밴드로 결과를 구분합니다.",
    "6. MOC와 Canvas를 새로고침합니다.",
    "7. 감사 기록을 남기고 언제든 되돌릴 수 있게 합니다.", "",
    "## 사용자 선호", "",
    "- 한국어를 기본으로 하되 English technical terms를 함께 씁니다.",
    "- 친근하고 가벼운 말투로, 초보자 수준에서 설명합니다.",
    "- 먼저 인문학적·일상적 비유를 들고, 보기 좋은 callout을 사용합니다.", "",
    "## 작업 체크리스트", "",
    "- 작업 전에 가이드와 MOC를 읽습니다.",
    "- 출처, 링크, 수식, 원문을 보존합니다.",
    "- 작업 후 MOC와 다음 AI용 가이드를 갱신합니다.", "",
    "#AI가이드 #인수인계 #시스템 #범용",
  ]);
}

export function renderHomeMoc(policy: VaultFoundationPolicy): string {
  const links = policy.areas.map((area) =>
    "- [[" + area.directory + "/000_" + area.slug + "_MOC]] — " + area.titleKo + " — " + area.purpose,
  );

  return joinMarkdown([
    "# 🧠 Brain Home MOC", "",
    "> [!abstract] 시작점", "> 사람과 AI가 Brain 전체를 탐색하는 공식 홈입니다.", "",
    "## 영역", "", ...links, "",
    "## 자동 색인", "", managedBlock,
  ]);
}

export function renderAreaMoc(area: AreaDefinition): string {
  return joinMarkdown([
    "# 📚 " + area.slug + " MOC", "",
    "> [!abstract] 영역 목적", "> " + area.purpose, "",
    "## 사람이 작성하는 설명", "",
    "이 영역의 목표와 중요한 맥락을 기록합니다.", "",
    "## 자동 색인", "", managedBlock, "",
    "## 상위", "", "- [[000_Home_MOC]]",
  ]);
}

function areaSpecificRule(area: AreaDefinition): string {
  switch (area.slug) {
    case "Study":
      return "- 인용에는 출처 제목, 섹션, 페이지 범위를 기록합니다.\n- 수식은 일상 비유 → 중학생 직관 → 수식 → 기호표 → 단계별 이유 순서를 지킵니다.";
    case "Research":
      return "- 연구 질문, 방법, 근거, 한계, 인사이트를 빠짐없이 기록합니다.";
    case "Project":
      return "- 목표, 상태, 결정, 결과물, 다음 행동을 항상 최신으로 유지합니다.";
    case "Development":
      return "- 환경, 재현 방법, 변경, 테스트, 롤백 정보를 함께 기록합니다.";
    case "Tools":
      return "- 설정 목적, 의존성, 검증, 복구 절차를 기록합니다.\n- 비밀 값은 절대 기록하지 않습니다.";
    default:
      return "- 이 영역은 루트 가이드의 전체 계약을 그대로 따릅니다. 목적은 " + area.purpose + "입니다.";
  }
}

export function renderAreaGuide(area: AreaDefinition): string {
  return joinMarkdown([
    "# " + area.titleKo + " 작업 가이드 — 다음 AI용", "",
    "> [!note] 먼저 읽기",
    "> 루트의 [[000_AI_WORK_GUIDE]]와 [[000_Home_MOC]]를 먼저 읽습니다.", "",
    "## 범위", "", area.purpose, "",
    "## 영역별 규칙", "", areaSpecificRule(area), "",
    "## 완료 조건", "",
    "- 원문 보존",
    "- 상위 MOC 연결",
    "- 실제 관련 노트만 연결",
    "- 출처가 있으면 페이지와 링크 기록",
  ]);
}
