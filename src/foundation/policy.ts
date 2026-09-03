export interface AreaDefinition {
  directory: string;
  slug: string;
  titleKo: string;
  purpose: string;
}

export interface VaultFoundationPolicy {
  version: string;
  inbox: "Agent-Inbox";
  maxDepth: 5;
  rootGuide: "000_AI_WORK_GUIDE.md";
  homeMoc: "000_Home_MOC.md";
  brainCanvas: "000_Brain_Map.canvas";
  areas: readonly AreaDefinition[];
}

export const BRAIN_FOUNDATION_POLICY: VaultFoundationPolicy = {
  version: "1.0.0",
  inbox: "Agent-Inbox",
  maxDepth: 5,
  rootGuide: "000_AI_WORK_GUIDE.md",
  homeMoc: "000_Home_MOC.md",
  brainCanvas: "000_Brain_Map.canvas",
  areas: [
    { directory: "00_Prompt", slug: "Prompt", titleKo: "프롬프트", purpose: "시스템 가이드와 재사용 프롬프트" },
    { directory: "01_Development", slug: "Development", titleKo: "개발", purpose: "코드, 설계, 구현 기록" },
    { directory: "10_Agent", slug: "Agent", titleKo: "AI 에이전트", purpose: "에이전트 구성과 운영" },
    { directory: "20_Study", slug: "Study", titleKo: "학습", purpose: "강의, 논문, 학습 노트" },
    { directory: "30_Business", slug: "Business", titleKo: "비즈니스", purpose: "사업과 운영 기록" },
    { directory: "40_Research", slug: "Research", titleKo: "연구", purpose: "연구 질문, 실험, 결과" },
    { directory: "50_Project", slug: "Project", titleKo: "프로젝트", purpose: "프로젝트별 실행 기록" },
    { directory: "60_Tools", slug: "Tools", titleKo: "도구", purpose: "도구와 서버 설정" },
    { directory: "98_DK", slug: "DK", titleKo: "기타 지식", purpose: "아직 확정되지 않은 기타 지식" },
    { directory: "99_Archive", slug: "Archive", titleKo: "보관", purpose: "완료 자료와 이력" },
  ],
};

export const areaMocPath = (area: AreaDefinition) =>
  `${area.directory}/000_${area.slug}_MOC.md`;
export const areaCanvasPath = (area: AreaDefinition) =>
  `${area.directory}/000_${area.slug}_Map.canvas`;
export const areaGuidePath = (area: AreaDefinition) =>
  `${area.directory}/99_작업가이드_다음AI용.md`;
