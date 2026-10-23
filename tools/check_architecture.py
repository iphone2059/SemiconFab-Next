"""Check flat one-project-per-domain layout, reference rules, DAG and frontend boundaries."""
from pathlib import Path
import json
import re
import xml.etree.ElementTree as ET

ROOT = Path(__file__).resolve().parents[1]
NAME = re.compile(r'^[a-z][a-z0-9]*(?:_[a-z0-9]+)+$')

SHARED = {
    'fab_ids', 'fab_contracts', 'fab_contracts_adapters', 'fab_messaging',
    'fab_observability', 'fab_hosting', 'fab_configuration',
    'fab_industrial_profiles', 'fab_security_policies', 'fab_optimization_abstractions',
}
SERVICES = {
    'site_service', 'manufacturing_service', 'process_engineering_service', 'equipment_service',
    'material_handling_service', 'maintenance_service', 'quality_service', 'site_resources_service',
    'orchestration_service', 'experiment_service', 'analytics_service', 'identity_service',
}
PLATFORM = {'eap_service', 'industrial_interfaces_service'}
ENGINE = 'simulation_engine'
HOSTS = {'api_service', 'worker_service', 'realtime_service', 'ot_gateway_service'}
TESTS = {'simulation_tests', 'orchestration_tests', 'api_tests'}
PURE_SHARED = {'fab_ids', 'fab_contracts', 'fab_optimization_abstractions', 'fab_security_policies', 'fab_industrial_profiles'}

for legacy in ('src', 'apps', 'tests', 'frontend'):
    assert not (ROOT / legacy).exists(), f'Legacy container remains: {legacy}'
for inherited in ('Directory.Build.props', 'Directory.Packages.props'):
    assert not (ROOT / inherited).exists(), f'Shared MSBuild file breaks project independence: {inherited}'
assert not list(ROOT.glob('*.sln*')), 'Repository must not contain a master solution (sln/slnx)'

projects = {}
for csproj in sorted(ROOT.glob('*/*.csproj')):
    name = csproj.stem
    assert csproj.parent.parent == ROOT and csproj.parent.name == name, f'Project must live flat at repo root: {csproj}'
    assert NAME.match(name), f'Project name must be lower_snake_case: {name}'
    assert name not in {'x_domain', 'x_application', 'x_infrastructure'}
    assert not name.endswith(('_domain', '_application', '_infrastructure')), f'Domain layers must be merged into one service project: {name}'
    projects[name] = (csproj, ET.parse(csproj).getroot())
assert len(projects) == 32, f'Expected 32 independent projects, found {len(projects)}'
assert set(projects) == SHARED | SERVICES | PLATFORM | {ENGINE} | HOSTS | TESTS, 'Unexpected project set: ' + str(set(projects) - (SHARED | SERVICES | PLATFORM | {ENGINE} | HOSTS | TESTS))

graph = {}
for name, (csproj, xml) in projects.items():
    assert xml.findall('.//TargetFramework'), f'{name} must declare TargetFramework itself'
    assert not xml.findall('.//ManagePackageVersionsCentrally') and not xml.findall('.//PackageVersion'), f'{name} must not rely on central package management'
    for package in xml.findall('.//PackageReference'):
        assert package.attrib.get('Version'), f'{name} PackageReference requires an explicit Version: {package.attrib.get("Include")}'
    refs = set()
    for ref in xml.findall('.//ProjectReference'):
        target = (csproj.parent / ref.attrib['Include']).resolve()
        found = [other for other, (p, _) in projects.items() if p.resolve() == target]
        assert found, f'Missing project reference: {name} -> {target}'
        refs.add(found[0])
    graph[name] = refs


def acyclic(edges):
    done, active = set(), set()

    def visit(node):
        assert node not in active, f'Dependency cycle at {node}'
        if node in done:
            return
        active.add(node)
        for target in edges.get(node, ()):
            visit(target)
        active.remove(node)
        done.add(node)

    for node in edges:
        visit(node)


acyclic(graph)


def no_io_sources(name):
    csproj, _ = projects[name]
    for source in csproj.parent.rglob('*.cs'):
        if {'obj', 'bin'} & set(source.parts):
            continue
        text = source.read_text(encoding='utf-8-sig')
        assert not re.search(r'^using (?:Microsoft\.AspNetCore|Microsoft\.EntityFrameworkCore|Npgsql|System\.Net\.Http)', text, re.M), f'I/O import in pure layer: {source}'


for name, (csproj, xml) in projects.items():
    refs = graph[name]
    if name in PURE_SHARED:
        assert not xml.findall('.//FrameworkReference'), f'Framework leaked into pure layer: {name}'
        assert not xml.findall('.//PackageReference'), f'Package in pure layer requires review: {name}'
        no_io_sources(name)
    if name == 'fab_ids':
        assert not refs, 'fab_ids must be dependency-free'
    elif name == 'fab_contracts':
        assert refs <= {'fab_ids'}, 'fab_contracts must only reference fab_ids'
    elif name in {'fab_optimization_abstractions', 'fab_security_policies', 'fab_industrial_profiles'}:
        assert refs <= {'fab_ids'}, f'{name} must only reference fab_ids'
    elif name == 'fab_contracts_adapters':
        assert refs <= {'fab_contracts'}, 'fab_contracts_adapters must only reference fab_contracts'
    elif name in {'fab_messaging', 'fab_observability', 'fab_hosting', 'fab_configuration'}:
        assert refs <= {'fab_contracts'}, f'{name} must only reference fab_contracts'
    elif name == ENGINE:
        assert refs <= {'fab_ids', 'fab_contracts', 'fab_optimization_abstractions'}, f'{name} may only use shared kernels'
        assert not xml.findall('.//FrameworkReference'), 'simulation_engine must stay framework-free'
        assert not xml.findall('.//PackageReference'), 'simulation_engine must stay package-free'
    elif name in SERVICES:
        allowed = SHARED | ({ENGINE} if name == 'orchestration_service' else set())
        assert refs <= allowed, f'Service may only depend on shared kernel: {name} -> {sorted(refs - allowed)}'
    elif name in PLATFORM:
        assert refs <= SHARED, f'Platform service may only depend on shared kernel: {name} -> {refs}'
    elif name in HOSTS:
        assert refs <= SHARED | SERVICES | PLATFORM | {ENGINE}, f'Host can only compose shared/services: {name} -> {refs}'
        assert not (refs & HOSTS), f'Host must not reference another host: {name} -> {refs}'
    elif name in TESTS:
        assert refs <= set(projects), 'Tests may reference any project'
    else:
        raise AssertionError('Unclassified project: ' + name)

for name in set(projects) - HOSTS - TESTS:
    assert not (graph[name] & HOSTS), f'Only hosts/tests may reference a host: {name} -> {sorted(graph[name] & HOSTS)}'

# frontend: exactly one self-contained website project
assert not (ROOT / 'package.json').exists(), 'Repository root must not contain a workspace package.json'
assert not (ROOT / 'pnpm-workspace.yaml').exists(), 'Repository root must not contain a pnpm workspace manifest'
assert not (ROOT / 'pnpm-lock.yaml').exists(), 'Repository root must not contain a workspace lockfile'
web = ROOT / 'web_app'
manifest = web / 'package.json'
assert manifest.exists(), 'web_app/package.json is required'
data = json.loads(manifest.read_text(encoding='utf-8'))
deps = {**data.get('dependencies', {}), **data.get('devDependencies', {})}
assert not [name for name in deps if name.startswith('@fab/')], 'web_app must not depend on internal @fab packages'
assert not [value for value in deps.values() if str(value).startswith('workspace:')], 'web_app must not use workspace protocol'
assert {'vitest', 'typescript', 'vite'} <= set(deps), 'web_app must own its frontend toolchain'
assert (web / 'pnpm-lock.yaml').exists(), 'web_app must commit its own pnpm lockfile'
other = [p.name for p in ROOT.glob('web_*') if p.is_dir() and p.name != 'web_app']
assert not other, f'Only one frontend project is allowed: {other}'
for source in (web / 'src').rglob('*'):
    if source.suffix not in {'.ts', '.tsx'}:
        continue
    text = source.read_text(encoding='utf-8')
    assert not re.search(r'getContext\(\s*[\'\"](?:webgl2?|experimental-webgl)[\'\"]', text), f'Forbidden WebGL context: {source}'
    assert not re.search(r"from ['\"]@fab/", text), f'Internal package import must be relative: {source}'
assert len(list((ROOT / 'docs/modules').glob('M*.md'))) == 18, 'Module record count changed'
print(f'PASS: {len(projects)} independent .NET projects (one service per domain) / 1 self-contained frontend project; flat layout, reference rules, DAG and module records.')
