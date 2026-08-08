현재 프로젝 트에서 thorvg.web의 webcanvas랑 claude agent sdk를 사용해서 프로젝트를 시작하려고해. 언어는 ts를 쓸거야. 브라우저에서 돌아가고 
must have
claude agent sdk를 사용해서 현재 몇개의 세션을 사용중인지 확인하고, 갯수만큼 webcanvas를 사용해서 화면에 그릴거야. 화면의 오른쪽에 위치하고 일렬로 줄 세울거야. 그리고 내 캐릭터만 움직일 수 있고, 채찍을 들고 있는데 특정 키를 입력하면 해당 채찍을 휘두를거야. 그래서 오른쪽에 위치한 클로드를 때릴 수 있도록. 모든 캐릭터는 클로드 처럼 생겼어. 
그리고 구현할때는 왜 그렇게 구현했는지에 대한 ADR(Architectural Decision Records)를 html로 문서화 해서 한곳에 모아놨으면 좋겠어.
deps
"@anthropic-ai/claude-agent-sdk"
"@thorvg/webcanvas",
typescript

good to have
이벤트 기반 개발(EDA)를 하려고해. 클로드와 상호작용하는 컴포넌트, 캔버스를 그리는 컴포넌트, 이 두개를 매니지 하는 컴포넌트(이거는 필요없을 수도 있음)
그래서 먼가 event queue를 두고 각 컴포넌트는 자기 역할에 집중하고 이벤트를 기반으로 동작을 취하는 방식으로 관심사를 분리하려고 해. 이부분은 backend.ai의 구조를 분석해서 너가 구조를 고려해봤으면 좋겠어.
이렇게 각 컴포넌트를 구별하려고 하는 이유는 해당 앱이 브라우저에서 돌아갈건데 최적화를 위해서 worker를 최대한으로 썼으면 좋겠어서 그래. 예를 들면 offScreen canvas를 사용할 수도 있겠지. 이부분은 너가 분석해서 알맞는 방법으로 구현했으면 해.
