"""Check project reference DAG, pure-layer rules and frontend package boundaries."""
from pathlib import Path
import json
import re
import xml.etree.ElementTree as ET

ROOT = Path(__file__).resolve().parents[1]
projects = {p.resolve(): ET.parse(p).getroot() for p in ROOT.rglob('*.csproj') if 'node_modules' not in p.parts}
graph = {}
for path, xml in projects.items():
    references = {(path.parent / ref.attrib['Include']).resolve() for ref in xml.findall('.//ProjectReference')}
    assert references <= projects.keys(), f'Missing project reference: {path}'
    graph[path] = references
    pure = path.stem.endswith('.Domain') or path.stem in {'Fab.Ids', 'Fab.Simulation.Core', 'Fab.Optimization.Abstractions', 'Fab.SecurityPolicies', 'Fab.IndustrialProfiles'}
    if pure:
        assert not xml.findall('.//FrameworkReference'), f'Framework leaked into pure layer: {path}'
        assert not xml.findall('.//PackageReference'), f'Package in pure layer requires explicit architecture review: {path}'
    if path.stem.endswith('.Domain'):
        assert all(ref.stem in {'Fab.Ids', 'Fab.SecurityPolicies', 'Fab.IndustrialProfiles', 'Fab.Optimization.Abstractions'} for ref in references), f'Domain dependency: {path}'
    if path.stem == 'Fab.Contracts':
        assert all(ref.stem == 'Fab.Ids' for ref in references), 'Contracts must not reference domain implementation'
    if path.stem.endswith('.Application'):
        owner = path.stem.removesuffix('.Application')
        assert all(not ref.stem.endswith(('.Infrastructure', '.Application')) and (not ref.stem.endswith('.Domain') or ref.stem == owner + '.Domain') for ref in references), f'Cross-domain implementation dependency: {path}'
    if pure:
        for source in path.parent.rglob('*.cs'):
            if 'obj' in source.parts:
                continue
            assert not re.search(r'^using (?:Microsoft\.AspNetCore|Microsoft\.EntityFrameworkCore|Npgsql|System\.Net\.Http)', source.read_text(encoding='utf-8-sig'), re.M), f'I/O import in pure layer: {source}'


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
listed = {(ROOT / item.attrib['Path']).resolve() for item in ET.parse(ROOT / 'SemiconFab.slnx').getroot().iter('Project')}
assert listed == projects.keys(), 'Solution project list differs from actual projects'
packages = {}
for folder in [ROOT / 'apps/web', *(ROOT / 'frontend/packages').glob('*')]:
    file = folder / 'package.json'
    if file.exists():
        packages[json.loads(file.read_text(encoding='utf-8'))['name']] = folder
edges = {}
for name, folder in packages.items():
    data = json.loads((folder / 'package.json').read_text(encoding='utf-8'))
    deps = {**data.get('dependencies', {}), **data.get('devDependencies', {})}
    edges[name] = {dep for dep in deps if dep in packages}
    if folder.name in {'fab-scene', 'realtime-sync'}:
        assert not any(dep.startswith('@babylonjs/') for dep in deps), f'Engine implementation leaked into {name}'
    for source in (folder / 'src').rglob('*'):
        if source.suffix not in {'.ts', '.tsx'}:
            continue
        text = source.read_text(encoding='utf-8')
        assert not re.search(r'getContext\(\s*[\'"](?:webgl2?|experimental-webgl)[\'"]', text), f'Forbidden WebGL context: {source}'
acyclic(edges)
assert len(list((ROOT / 'docs/modules').glob('M*.md'))) == 18
print(f'PASS: {len(projects)} .NET projects / {len(packages)} frontend packages; DAG, module records and pure-layer boundaries.')
