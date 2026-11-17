# Tomcat Workbench

Execute versões independentes do Apache Tomcat no VS Code, com um Java próprio por instância, sem instalar Java, Tomcat, Maven, Gradle ou Docker no computador.

Compatível com **VS Code Desktop 1.96+ no Windows x64 ou ARM64**, com Tomcat **8.5, 9.0, 10.1 e 11.0**. Os binários para ARM64 dependem da disponibilidade do Temurin para a versão escolhida. A extensão não funciona em VS Code Web, SSH, WSL ou Dev Containers nesta versão.

## Instalar e começar

1. No VS Code, execute **Extensions: Install from VSIX...** e selecione `tomcat-workbench-0.9.0.vsix`. O mesmo procedimento atualiza a versão anterior; recarregue o VS Code se solicitado.
2. Abra uma pasta local e marque o workspace como confiável.
3. Execute **Tomcat: Create Instance**. Escolha família, versão exata, JDK e portas.
4. Use o painel **Tomcat Servers**, no Explorer, para iniciar o servidor e consultar o console.
5. Execute **Tomcat: Deploy Application** para selecionar um WAR ou diretório dentro do projeto. Use `/` para a aplicação raiz.
6. Execute **Tomcat: Open Application** para abrir o navegador. Sem aplicação publicada, o Tomcat responde 404: exemplos, Manager e página padrão não são instalados nas instâncias.

Criar uma instância baixa as distribuições oficiais necessárias; o primeiro provisionamento exige rede. Execuções posteriores usam o cache local sem consultar o catálogo. Downloads têm verificação SHA-512 (Tomcat) ou SHA-256 (Temurin) e não usam instaladores ou privilégios administrativos.

## Configuração por projeto

A extensão cria `.vscode/tomcat.json`, que pode ser versionado. O editor oferece validação e sugestões pelo esquema JSON. Exemplo ilustrativo de versões fixas (use o assistente para selecionar releases disponíveis e atuais):

```json
{
  "version": 1,
  "instances": [{
    "id": "backend",
    "name": "Backend local",
    "tomcatVersion": "10.1.34",
    "java": { "major": 17, "release": "jdk-17.0.13+11" },
    "ports": { "http": 8080, "shutdown": 8005 },
    "debug": { "port": 5005 },
    "jvmArgs": ["-Xms128m", "-Xmx512m", "-Dapp.profile=local"],
    "environment": { "APP_ENV": "development", "DB_PASSWORD": "${secret:database}" },
    "libraries": ["drivers/database-driver.jar"],
    "applications": [{ "source": "target/backend.war", "context": "/backend" }]
  }]
}
```

- `id` identifica os dados locais; alterar o id cria outra instância. Nome e portas são editáveis.
- Tomcat e JDK ficam fixos na versão completa, sem atualização automática. A extensão executa Tomcat 8.5 e 9 com Java 8+, 10.1 com Java 11+ e 11 com Java 17+. São oferecidos Temurin 8, 11, 17 e 21; Java 7 não é gerenciado.
- Tomcat 8.5 pode ser selecionado em **Create Instance**, com versões disponíveis no arquivo oficial da Apache. A família está fora de suporte desde 31/03/2024; sua última versão é 8.5.100. [Referência oficial](https://tomcat.apache.org/whichversion.html)
- Cada elemento de `jvmArgs` é um argumento completo, sem aspas de shell, inclusive quando contém espaços. As propriedades usadas para diretórios, logging e identificação do processo são reservadas.
- `environment` é aplicado somente ao processo da instância. Variáveis herdadas que alteram o Java/Tomcat são removidas. `JAVA_HOME`, `JRE_HOME`, `JAVA_OPTS`, `CATALINA_*`, opções globais Java e classpath não podem sobrescrever o gerenciamento da extensão.
- `libraries` copia JARs com nomes distintos para o `lib` exclusivo da instância. As bibliotecas deixam de ser carregadas quando removidas da lista e o servidor é reiniciado.
- Caminhos são relativos ao projeto. Fontes de deploy e configurações não podem escapar da pasta; links simbólicos e junctions não são suportados nesses arquivos.
- Portas devem ser diferentes entre todas as instâncias do projeto, entre 1024 e 65535. Conflitos com outros processos produzem erro; não há substituição silenciosa de porta.

Pare o servidor antes de editar a configuração. Alterações manuais são aplicadas na próxima inicialização; não há hot reload. WARs devem estar construídos previamente: a extensão executa o servidor, sem compilar o projeto.

## Configuração nativa avançada

Execute **Tomcat: Initialize Native Configuration** para gerar arquivos da versão selecionada em `.vscode/tomcat/<id>` e cadastrar `configDir`. A pasta contém `server.xml`, `web.xml`, `context.xml`, usuários, logging e configurações de contexto. Certificados e arquivos auxiliares podem ser incluídos nela, mas não versione chaves privadas ou credenciais.

Os modelos usam `${http.port}`, `${shutdown.port}` e `${shutdown.token}`. Os dois primeiros devem corresponder a `ports` no JSON; valores contraditórios impedem a inicialização. O token de parada é gerado localmente. O XML compartilhado nunca recebe esse token.

É possível configurar TLS, conectores adicionais, recursos JNDI e contextos usando XML nativo. Esta versão gerencia **um Host por instância, com `appBase="webapps"`** e um conector HTTP na porta declarada. A porta de shutdown deve permanecer em loopback. Os demais conectores também começam em loopback, mas podem ser alterados explicitamente no XML. Portas adicionais são verificadas antes da execução.

Os modelos têm um marcador de família. Mudar entre 8.5, 9, 10.1 e 11 exige gerar modelos correspondentes ou restaurar a versão anterior; não há conversão automática de XML. Gerar novamente preserva a pasta anterior em um backup adjacente. Trocar uma versão exata também preserva a configuração de execução anterior em `backups` nos dados locais.

O Java é iniciado diretamente com o Bootstrap oficial do Tomcat. `setenv.bat`, scripts externos e serviços Windows não são executados; configure argumentos e ambiente no JSON. XML com DOCTYPE/entidades externas é recusado.

## Build Maven e deploy automático

Use **Tomcat: Build and Run** ou **Tomcat: Build and Debug** para construir a aplicação antes de publicá-la. Na primeira execução, selecione o POM do módulo WAR e o contexto. **Tomcat: Build WAR** gera somente o artefato, preservando o servidor em execução; **Tomcat: Preview Build POM** resolve o modelo Maven e abre o POM derivado para consulta.

A extensão baixa e verifica seu próprio **Maven 3.9.16**, usa o JDK da instância e não requer `mvn` no PATH. Maven e JDK ficam em cache. A resolução das dependências respeita os repositórios e perfis do projeto e o `settings.xml` padrão do usuário. Configurações globais de outra instalação de Maven não são herdadas.

Configuração mínima por instância:

```json
"build": {
  "pom": "pom.xml",
  "context": "/backend"
}
```

O POM original é lido pelo Maven Help Plugin para obter o modelo efetivo, incluindo herança e perfis ativos. Um POM derivado é gerado ao lado dele para preservar a base dos caminhos relativos; esse arquivo temporário é removido ao final. A saída convencional, inclusive caminhos herdados de perfis/execuções sob o diretório de build, é redirecionada para `.tomcat-workbench/<id>/build`. A limpeza é feita pela extensão somente nesse diretório verificado, sem executar regras `clean` herdadas. Plugins personalizados continuam executando código do projeto e podem ter efeitos próprios: o build exige workspace confiável e não é um sandbox.

Por padrão, dependências `compile`/`runtime` seguem o empacotamento Maven normal e as `provided` são incluídas automaticamente em `WEB-INF/lib`, com exclusões para Tomcat embutido, APIs do container e ferramentas como Lombok/QueryDSL APT. Os testes não são copiados. Quando o projeto usa `spring-boot-starter-log4j2`, o WAR local exclui bindings concorrentes conhecidos (`slf4j-jdk14`, Logback e a ponte `log4j-to-slf4j`). O build usa versões fixas dos plugins Help 3.5.1, Compiler 3.11.0, Dependency 3.6.1 e WAR 3.4.0, compatíveis com Java 8.

Opções adicionais:

```json
"build": {
  "pom": "pom.xml",
  "context": "/backend",
  "mavenVersion": "3.9.16",
  "includeProvided": true,
  "skipTests": false,
  "goal": "package",
  "profiles": ["local"],
  "settings": "C:/Users/andre.oliveira/.m2/settings.xml",
  "dependencies": [
    { "groupId": "org.apache.httpcomponents", "artifactId": "httpclient" }
  ]
}
```

`dependencies` inclui ou ajusta dependências somente no POM derivado. A versão pode vir do dependency management original ou ser informada explicitamente. A extensão não adivinha bibliotecas ausentes de toda a árvore Maven. `excludeArtifacts` exclui artifactIds adicionais do WAR; `excludeProvidedGroups` restringe apenas a cópia adicional de grupos `provided`. `jvmArgs` permite opções extras da JVM do Maven. Perfis podem ser ativados por nome ou desativados com `!nome`.

`build.settings` indica o arquivo XML, e não a pasta. Aceita caminho absoluto (inclusive fora do projeto) ou relativo à raiz do projeto, como `.mvn/settings.xml`. No Windows, use `/` ou escape as barras como `C:\\Users\\usuario\\.m2\\settings.xml`. O mesmo arquivo é passado com `-s` na resolução do modelo e no build, respeitando mirrors, servidores/credenciais, proxies, perfis e `localRepository` do Maven. O arquivo não é copiado nem alterado pela extensão; sem esse campo, o Maven usa seu settings padrão. Arquivos ausentes ou caminhos para pastas geram erro antes do build.

O objetivo padrão é `package`. `install` é opcional e também instala o artefato de desenvolvimento e seu POM derivado no repositório Maven local. Os testes são executados por padrão; `skipTests: true` desativa sua execução para o build local. A primeira resolução requer acesso aos repositórios; o Maven usa os caches disponíveis nas execuções seguintes. Proxy/certificados do processo Maven devem ser configurados nos settings ou argumentos JVM apropriados; o proxy dos downloads da extensão é independente.

Um build bem-sucedido cria uma cópia imutável do WAR em `.tomcat-workbench/<id>/artifacts`. **Build and Run/Debug** atualiza o deploy somente depois do sucesso e reinicia a instância. Uma falha de compilação preserva o deploy e o servidor anteriores. O comando pode ser cancelado e tem limite de 20 minutos por execução Maven; no Windows, o cancelamento encerra a árvore de processos capturada. Builds ativos são cancelados ao desativar a extensão. Locks também registram PIDs dos processos Maven para evitar que outra janela limpe uma saída ainda em uso após falha do host.

O último POM derivado fica em `last-pom.xml` e o resultado em `last-build.json`, na pasta da instância em `.tomcat-workbench`. Os snapshots antigos são preservados para não invalidar deployments que ainda os referenciam; remova-os manualmente quando não forem mais utilizados. A pasta contém um `.gitignore` local. Uma interrupção abrupta do host pode deixar um POM temporário ao lado do original; confirme que não há build em execução antes de removê-lo.

Esta versão aceita módulos Maven com `packaging=war`. Para projetos com vários módulos, selecione o POM de um módulo WAR dentro da pasta aberta; construir o reactor inteiro ainda não é suportado. Dependências locais de outros módulos precisam estar disponíveis no repositório Maven.

### Hot reload

Execute **Tomcat: Configure Hot Reload** para escolher **Off**, **HotSwap** ou **Rebuild and redeploy** por instância. Configure o intervalo após o último salvamento Java (200 a 30000 ms, padrão 1000). O recurso fica desligado até ser configurado e só age quando a instância está em execução. Somente o salvamento de documentos `.java` no VS Code aciona o hot reload, em ambos os modos, incluindo Save All e Auto Save. Salvar XML, HTML, CSS, JavaScript, properties ou pom.xml não aciona o mecanismo, mesmo com padrões watch amplos. Mudanças externas no disco e eventos de criação/remoção também não o acionam. Salvamentos Java durante uma operação são agrupados para uma atualização posterior.

Exemplo no nível da instância, ao lado de `build` e `debug`:

```json
"hotReload": {
  "mode": "hotswap",
  "delayMs": 1000,
  "watch": ["src/**"],
  "exclude": ["src/test/**"]
}
```

**HotSwap:** inicie **Build and Debug** ou **Debug**, aguarde a conexão do debugger e salve um arquivo Java. A extensão solicita uma compilação incremental ao suporte Java do VS Code e envia as classes modificadas para a sessão de debug dessa instância, sem reiniciar o Tomcat. Também há o comando **Tomcat: Apply HotSwap**, independentemente de o modo automático estar habilitado. Requer **Language Support for Java by Red Hat**, **Debugger for Java** e o projeto importado no suporte Java, com seu classpath válido. Essa compilação usa o compilador/classpath do suporte Java, não o Maven gerenciado da extensão; um projeto que compila apenas com adaptações do POM derivado pode precisar ajustar sua importação Java antes de usar HotSwap.

Alterações no corpo de métodos são o caso usual. Adicionar/remover membros, mudar assinaturas ou hierarquia pode ser rejeitado pela JVM. A extensão registra o erro e indica **Build and Debug**; não reinicia automaticamente após uma rejeição. Alterações em XML, recursos, POM, HTML/CSS/JS e classes removidas exigem rebuild/redeploy; o modo HotSwap monitora somente arquivos `.java`. A definição do WAR em disco não é atualizada por HotSwap: um futuro reinício usa o último WAR/deploy, salvo se você executar um novo build. As configurações globais `java.debug.settings.hotCodeReplace` e `java.autobuild.enabled` não são alteradas pela extensão. Se outro mecanismo do debugger já aplicou a alteração, não haverá classes pendentes no pedido da extensão.

**Rebuild/redeploy:** use `"mode": "redeploy"` e configure o bloco `build`. Após salvar um arquivo Java monitorado, a extensão compila um novo WAR com Maven gerenciado e reinicia esta instância do Tomcat, mantendo o modo normal/debug anterior. Sessões HTTP e estado em memória podem ser perdidos. Compilação malsucedida preserva o servidor e o último deploy bem-sucedido. Para atualizar recursos estáticos ou configurações sem salvar Java, execute Build and Run/Debug manualmente. Não há cópia incremental nem publish pelo Manager nesta versão.

`watch` e `exclude` aceitam caminhos relativos ao projeto com `/`, `*`, `**` e `?`. O padrão é `src/**`; para um módulo Maven em subpasta, informe seus caminhos explicitamente. Sempre são ignorados diretórios `target`, `.tomcat-workbench`, `.git`, `.vscode`, `.local`, `node_modules`, `dist`, `out`, `coverage` e POMs temporários da extensão. Um arquivo excluído por esses filtros internos não pode ser reabilitado em `watch`.

**Stop** cancela trabalho ativo e pendente; mudanças de configuração/removal invalidam tarefas antigas. Operações de deploy/templates/start/restart não concorrem com o reload da mesma instância. Desativar Hot Reload cancela trabalho pendente e impede a publicação/reinicialização automática ainda não iniciada. Os diagnósticos e resultados ficam no console da instância. Não há garantia de rollback de um erro de inicialização ocorrido depois de um build bem-sucedido.

Referências do debugger: [Hot Code Replace e limitações](https://github.com/microsoft/vscode-java-debug/wiki/Hot-Code-Replace), [compilação incremental usada pelo debugger](https://github.com/microsoft/vscode-java-debug/blob/main/src/build.ts).

### Diagnóstico de dependências ausentes

O monitoramento dos logs permanece ativo mesmo sem `build.dependencies`. Se Build and Run/Debug detectar classes ausentes na inicialização, o diagnóstico abre automaticamente após a liberação da operação, sem depender de clicar em uma notificação. Se outro build começar enquanto você escolhe a instância ou aceita a oferta, o diagnóstico fica pendente e abre depois. O comando manual também aguarda um build em andamento. Remover uma dependência pode fazer a aplicação falhar novamente, mas não desativa sua identificação nem exige restaurar a configuração manualmente. A inclusão sugerida continua sujeita a confirmação.

Ao encontrar `ClassNotFoundException` ou `NoClassDefFoundError` nos logs do Tomcat, Build and Run/Debug abre automaticamente **Diagnose Dependencies** após a tentativa de inicialização. Para execuções manuais de Start/Debug, aparece uma oferta modal de diagnóstico. O console registra as etapas de detecção, agendamento e abertura. Escolha o provedor e confirme a alteração para que a biblioteca seja salva em `build.dependencies`; cancelar mantém o arquivo intacto. Também é possível executar **Tomcat: Diagnose Missing Dependencies** pela paleta ou pelo menu da instância. Depois de recarregar o VS Code, o comando consulta o último 1 MiB do console persistido quando não há exceções na sessão atual.

O diagnóstico resolve o modelo efetivo e consulta `settings.localRepository` usando o Maven/JDK da instância e o `build.settings` configurado. Em seguida, busca a classe exata dentro dos JARs já presentes nesse repositório. As versões do `dependencyManagement` aparecem primeiro. Selecione o provedor compatível para cada classe; Escape ignora a classe. A extensão mostra as coordenadas e pede confirmação para **Save Only**, **Build and Run** ou **Build and Debug**. A versão selecionada fica explícita em `build.dependencies`, inclusive quando coincide com a gerenciada, garantindo que o próximo build use o JAR escolhido. O POM original permanece preservado.

A busca pode ser cancelada, ignora links, JARs com classifier, componentes do Tomcat/APIs do contêiner e ferramentas, e inspeciona até 30 mil JARs. Falhas de leitura e limite atingido aparecem no console. A busca de classes não baixa artefatos nem adiciona todas as entradas do dependencyManagement. A resolução do modelo pode baixar plugins/POMs pelo Maven. Se a classe não existir no cache, consulte a dependência com quem mantém a aplicação; nenhuma coordenada é inventada. Erros de inicialização estática e incompatibilidades de versões exigem diagnóstico próprio. Este fluxo analisa os erros de execução; ainda não faz análise estática de bytecode antes do deploy.

**Migração de configurações legadas:** bibliotecas declaradas em `libraries` e o XML nativo continuam ativos. Para um WAR completo, remova bibliotecas compartilhadas de Spring/Swagger e restaure o classloader padrão, evitando duplicidade com `WEB-INF/lib`. Recursos JNDI e bibliotecas realmente pertencentes ao servidor, como um driver JDBC de datasource, permanecem configurações do ambiente.

## Depurar a aplicação

1. Instale **Debugger for Java**, da Microsoft, e abra o código-fonte da aplicação no workspace. O Extension Pack for Java também inclui esse depurador.
2. No painel **Tomcat Servers**, use o botão **Debug** ou execute **Tomcat: Debug** pela Command Palette.
3. A extensão inicia a JVM com JDWP em `127.0.0.1` e conecta automaticamente o depurador Java. Não é necessário criar `launch.json` ou configurar JDWP em `jvmArgs`.
4. Coloque breakpoints no código correspondente ao WAR/diretório publicado e faça uma requisição à aplicação. O artefato deve corresponder ao código aberto e conter informações de depuração.

Se o servidor já estiver executando normalmente, a interface oferece reiniciá-lo em debug. Se já estiver em debug, o comando conecta novamente sem reiniciá-lo. **Stop Debug (Disconnect)** e o botão de desconexão do VS Code encerram somente a sessão do depurador; o Tomcat continua executando com sua porta JDWP em loopback. Para encerrar o servidor, use **Tomcat: Stop**. Para voltar à execução sem JDWP, use **Stop** seguido de **Start**.

O primeiro comando Debug atribui uma porta livre entre as portas declaradas no projeto, começando em 5005, e a salva em `tomcat.json`. A disponibilidade no Windows é verificada antes de iniciar a JVM. Você pode configurar cada instância:

```json
"debug": {
  "port": 5005,
  "projectName": "backend",
  "sourcePaths": ["src/main/java"]
}
```

Somente `port` é obrigatório quando o bloco `debug` é informado; `projectName` e `sourcePaths` ajudam a resolver fontes quando há vários projetos Java. Os diretórios são relativos ao projeto. A porta deve ser diferente das portas HTTP, shutdown e debug das outras instâncias. Alterações na porta entram em vigor após reiniciar; reconectar a uma JVM recuperada usa sua porta efetiva.

**Start** continua iniciando sem debug, mesmo com o bloco `debug` configurado. **Restart** e operações de deploy que reiniciam um servidor em debug preservam esse modo e reconectam o depurador. Se o attach falhar após uma nova inicialização de debug, a extensão encerra a JVM que acabou de iniciar; uma instância em debug que já existia é preservada.

Remova argumentos JDWP manuais (`-agentlib:jdwp` ou `-Xrunjdwp`) de `jvmArgs` antes de usar o Debug integrado. A JVM inicia com `suspend=n`; esta versão conecta após a inicialização do Tomcat e não pausa sua inicialização para capturar breakpoints anteriores ao attach. Não há compilação automática nem garantia de Hot Code Replace além do que o depurador Java e a JVM suportam.

## Segredos

Execute **Tomcat: Set Project Secret** e referencie o nome em valores de `environment`, por exemplo `${secret:database}`. Cada computador cadastra seus próprios valores no SecretStorage do VS Code. Segredos ausentes impedem o início.

A extensão remove esses valores conhecidos do console que grava em `logs/console.log`. Logs gerados pela aplicação ou pelo próprio Tomcat podem conter dados sensíveis; a extensão não controla o que a aplicação grava.

## Operação, recuperação e dados locais

O painel e a Command Palette oferecem iniciar, parar, reiniciar, console, pasta de logs, navegador, deploy, undeploy e remoção da instância. Deploy e undeploy usam uma área de preparação e são feitos com o servidor parado; se ele estiver executando, a interface oferece parada e reinício. Os arquivos-fonte não são removidos.

Distribuições e instâncias ficam no `globalStorage` do VS Code, sob `local-development.tomcat-workbench`. Cada caminho de projeto e id tem diretórios separados para configuração, aplicações, bibliotecas, logs, trabalho e temporários. Os binários são compartilhados por versão e não são editados.

Locks impedem que duas janelas operem a mesma instância simultaneamente. No encerramento normal da extensão, os servidores são parados. Após falha do VS Code, a recuperação confere PID, executável, instante de criação e argumento de identificação antes de assumir um processo existente. Não é necessário instalar um serviço auxiliar.

Se uma falha ocorrer antes de gravar o proprietário de um lock ou confirmar a identidade do processo, a extensão mantém os dados e exige inspeção manual. Feche todas as janelas do VS Code, confira o processo indicado no `process.json` e só remova locks órfãos depois de confirmar que nenhuma operação os utiliza. Um PID reutilizado pode exigir esse procedimento conservador.

**Tomcat: Remove Local Instance Data** apaga dados de execução de uma instância parada, mantendo configuração do projeto e distribuições. **Remove Instance** remove a declaração do projeto e preserva logs e modelos. Para desinstalação completa, pare todas as instâncias, desinstale a extensão e remova sua pasta de `globalStorage`; certificados/segredos devem ser tratados conforme sua política local.

## Rede

São usados os fornecedores oficiais `archive.apache.org`, `dlcdn.apache.org`, `api.adoptium.net` e os assets do GitHub/Adoptium. A extensão considera `http.proxy` do VS Code ou as variáveis de proxy do ambiente. A validação TLS permanece habilitada; configure a CA corporativa pelo mecanismo do Node (`NODE_EXTRA_CA_CERTS`, antes de iniciar o VS Code), quando necessário. Importação manual offline de distribuições fica para uma versão futura.

## Desenvolver e validar

Node.js 22+ é necessário **apenas para desenvolver a extensão**.

```powershell
npm install
npm run check
npm test
npm run build
npm run test:integration
npm run package
```

`npm test` executa testes locais sem downloads. `test:integration` baixa distribuições reais para `.integration-data`, inicia as quatro famílias no Windows (incluindo Tomcat 8.5 com Java 8), verifica isolamento e deploy por HTTP e encerra os processos. Também compila um cliente JDI para validar breakpoints e usa o Maven gerenciado para construir/publicar um WAR, validar inclusão de dependências `provided`, exclusão de container, preservação do target e manutenção do deploy após falha de compilação. Os binários ficam em cache para repetições. Não é um teste automatizado da interface gráfica do VS Code.

Pressione F5 neste repositório para abrir um Extension Development Host e testar a interface em uma pasta de projeto separada. O VSIX usa o publisher local `local-development`; publicação no Marketplace não está incluída.

Independência das instalações não equivale a isolamento de segurança: o servidor, o build e a aplicação têm as permissões do usuário no Windows. Compatibilidade da aplicação, incluindo a mudança de `javax` para `jakarta`, continua sendo responsabilidade do projeto. Gradle, containers, outros sistemas e execução remota ficam fora desta versão.
