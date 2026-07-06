import os
import webbrowser
from flask import Flask, render_template, request, jsonify
from scanner import (
    start_scan,
    get_progress,
    get_node,
    get_drive_scan_status,
    get_drive_task_id,
    prefetch_all_drives,
    start_drive_scan
)
from utils import format_size

app = Flask(__name__)

# ---------- 聚合算法 ----------
SMALL_FILE_THRESHOLD = 100 * 1024 * 1024  # 100 MB
MAX_ITEMS_BEFORE_AGGREGATE = 25

def aggregate_children(children):
    """将混合的子项(文件+目录)处理为前端友好的数据，包含小文件聚合和大项截断"""
    small_files = []
    large_files = []
    dirs = []
    for child in children:
        if child['type'] == 'file':
            if child['size'] < SMALL_FILE_THRESHOLD:
                small_files.append(child)
            else:
                large_files.append(child)
        else:
            dirs.append(child)

    result = []
    # 大文件直接独立
    for f in large_files:
        result.append({
            'name': f['name'],
            'path': f['path'].replace('\\', '/'),
            'size': f['size'],
            'size_str': format_size(f['size']),
            'type': 'file',
            'has_children': False
        })

    # 小文件聚合为一个扇区
    if small_files:
        total_small_size = sum(f['size'] for f in small_files)
        result.append({
            'name': f'小文件 (共{len(small_files)}个)',
            'path': '',
            'size': total_small_size,
            'size_str': format_size(total_small_size),
            'type': 'aggregate_small_files',
            'has_children': False,
            'count': len(small_files)
        })

    # 目录扇区
    for d in dirs:
        result.append({
            'name': d['name'],
            'path': d['path'].replace('\\', '/'),
            'size': d['size'],
            'size_str': format_size(d['size']),
            'type': 'dir',
            'has_children': d.get('has_children', False)
        })

    # 按大小降序
    result.sort(key=lambda x: x['size'], reverse=True)

    # 若项数过多，保留前 MAX_ITEMS 个，其余归入“其他”
    if len(result) > MAX_ITEMS_BEFORE_AGGREGATE:
        top = result[:MAX_ITEMS_BEFORE_AGGREGATE]
        others = result[MAX_ITEMS_BEFORE_AGGREGATE:]
        total_other_size = sum(item['size'] for item in others)
        other_item = {
            'name': f'其他 ({len(others)}项)',
            'path': '',
            'size': total_other_size,
            'size_str': format_size(total_other_size),
            'type': 'aggregate_other',
            'has_children': False,
            'count': len(others)
        }
        top.append(other_item)
        top.sort(key=lambda x: x['size'], reverse=True)
        result = top

    return result

# ---------- API ----------
@app.route('/')
def index():
    return render_template('index.html')

@app.route('/api/drives')
def drives():
    import psutil
    import concurrent.futures as _cf
    parts = psutil.disk_partitions()
    drives = []
    for p in parts:
        # disk_usage 在不可达的网络盘/光驱上会挂起，加超时保护
        try:
            with _cf.ThreadPoolExecutor(max_workers=1) as ex:
                usage = ex.submit(psutil.disk_usage, p.mountpoint).result(timeout=2)
        except Exception:
            continue
        try:
            path = p.mountpoint.replace('\\', '/')
            status = get_drive_scan_status(path)
            task_id = get_drive_task_id(path)
            drives.append({
                'label': path,
                'total': usage.total,
                'total_str': format_size(usage.total),
                'used': usage.used,
                'free': usage.free,
                'scan_status': status,
                'task_id': task_id
            })
        except Exception:
            continue
    return jsonify(drives)

@app.route('/api/scan', methods=['POST'])
def scan():
    data = request.get_json()
    path = data.get('path')
    if not path:
        return jsonify({'error': 'Path required'}), 400
    # 标准化路径，并确保盘符格式统一
    path = os.path.normpath(path)
    task_id = start_scan(path)
    return jsonify({'task_id': task_id})

@app.route('/api/progress/<task_id>')
def progress(task_id):
    info = get_progress(task_id)
    if info is None:
        return jsonify({'error': 'Invalid task id'}), 404
    return jsonify(info)

@app.route('/api/children')
def children():
    path = request.args.get('path', '')
    if not path:
        return jsonify({'error': 'Path required'}), 400
    norm_path = os.path.normpath(path)
    node = get_node(norm_path)
    if node is None:
        return jsonify({'error': 'Path not found or not scanned'}), 404
    if node['type'] != 'dir':
        return jsonify({'error': 'Not a directory'}), 400

    raw_children = node.get('children', [])
    result = aggregate_children(raw_children)
    return jsonify(result)

@app.route('/api/subdirs')
def subdirs():
    path = request.args.get('path', '')
    if not path:
        return jsonify([])
    norm_path = os.path.normpath(path)
    node = get_node(norm_path)
    if node is None or node['type'] != 'dir':
        return jsonify([])

    children = node.get('children', [])
    dirs = []
    for c in children:
        if c['type'] == 'dir':
            # 检查是否有子目录（至少有一层子目录）
            has_subdirs = any(sub['type'] == 'dir' for sub in c.get('children', []))
            dirs.append({
                'name': c['name'],
                'path': c['path'].replace('\\', '/'),
                'has_children': has_subdirs
            })
    return jsonify(dirs)

@app.route('/api/rescan', methods=['POST'])
def rescan():
    data = request.get_json(silent=True) or {}
    path = data.get('path')
    if not path:
        return jsonify({'error': 'Path required'}), 400
    path = os.path.normpath(path)
    task_id = start_drive_scan(path)
    return jsonify({'task_id': task_id})

# ---------- 启动 ----------
if __name__ == '__main__':
    # 程序启动时立即开始后台预扫描所有盘符
    prefetch_all_drives()

    port = 5000
    webbrowser.open(f'http://127.0.0.1:{port}')
    app.run(host='127.0.0.1', port=port, debug=False, threaded=True)