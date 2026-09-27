import os

app_js_path = os.path.join(os.path.dirname(__file__), 'public', 'app.js')

with open(app_js_path, 'r', encoding='utf-8') as f:
    content = f.read()

# Replace fetch('/api/ and fetch(`/api/ and EventSource('/api/
updated = content.replace("fetch('/api/", "fetch(`${API_BASE}/api/")
updated = updated.replace("fetch(`/api/", "fetch(`${API_BASE}/api/")
updated = updated.replace("EventSource('/api/", "EventSource(`${API_BASE}/api/")
updated = updated.replace("url = shiftId ? `/api/shifts/", "url = shiftId ? `${API_BASE}/api/shifts/")
updated = updated.replace(": '/api/shifts'", ": `${API_BASE}/api/shifts`")

with open(app_js_path, 'w', encoding='utf-8') as f:
    f.write(updated)

print("UPDATED APP.JS WITH API_BASE BACKEND ROUTING SUCCESSFULLY.")
