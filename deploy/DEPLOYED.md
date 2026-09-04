# Oracle 배포 현황

> [!success] 검증된 운영 서버
> OBRAIN MCP가 Oracle Always Free VM에서 HTTPS로 실행 중이며, FLOW 전용 읽기 계정으로 실제 동기화를 검증했다.

## 공개 배포 정보

- HTTPS MCP: `https://144-24-67-37.sslip.io/mcp`
- Health: `https://144-24-67-37.sslip.io/healthz`
- Region: `ap-chuncheon-1`
- Shape: `VM.Standard.E2.1.Micro`
- Application commit: `bec03874d70a92c9bee30b97100edc0ab2050d16`
- Verified date: `2026-09-04`

## 확인된 연결

- `brain-mcp`, `caddy`, `brain-syncthing`: active
- FLOW service identity: `flow`
- Scope: `notes:read`
- Allowed Vaults: `brain`
- FLOW 최초 증분 동기화: cursor 39, upsert 39
- FLOW 실검색 및 Knowledge Graph 생성: 성공

> [!note] 비밀정보 위치
> 비밀번호·토큰·원문 비밀값은 이 문서와 Git 저장소에 기록하지 않는다. Oracle은 단방향 scrypt 해시만 보관하고, FLOW는 배포 환경의 비밀 저장소를 사용한다.
