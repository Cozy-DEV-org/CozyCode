// CozyCode — Tauri entry point. No telemetry, ever.
#![cfg_attr(not(debug_assertions), windows_subsystem = "windows")]

mod ai_cmds;
mod ext_cmds;
mod fs_cmds;
mod gh_cmds;
mod git_cmds;
mod misc_cmds;
mod proc_cmds;
mod pty_cmds;
mod search_cmds;
mod ssh_cmds;
mod sys_cmds;
mod tunnel_cmds;
mod util;

fn main() {
    tauri::Builder::default()
        .plugin(tauri_plugin_dialog::init())
        .plugin(tauri_plugin_updater::Builder::new().build())
        .plugin(tauri_plugin_process::init())
        .setup(|app| {
            // set the window/taskbar icon from the proper multi-size .ico
            if let Ok(img) = tauri::image::Image::from_bytes(include_bytes!("../icons/cozycode256x256.ico")) {
                use tauri::Manager;
                if let Some(w) = app.get_webview_window("main") {
                    let _ = w.set_icon(img);
                }
            }
            Ok(())
        })
        .manage(pty_cmds::PtyState::default())
        .manage(ssh_cmds::SshState::default())
        .manage(proc_cmds::ProcState::default())
        .manage(tunnel_cmds::TunnelState::default())
        .invoke_handler(tauri::generate_handler![
            fs_cmds::list_dir,
            fs_cmds::read_file,
            fs_cmds::read_file_base64,
            fs_cmds::write_file_encoded,
            fs_cmds::write_file,
            fs_cmds::create_file,
            fs_cmds::create_dir,
            fs_cmds::rename_path,
            fs_cmds::delete_path,
            fs_cmds::md_graph,
            search_cmds::search_text,
            search_cmds::search_replace,
            search_cmds::list_files,
            git_cmds::git_info,
            git_cmds::git_status,
            git_cmds::git_stage,
            git_cmds::git_unstage,
            git_cmds::git_discard,
            git_cmds::git_commit,
            git_cmds::git_diff_file,
            git_cmds::find_repos,
            git_cmds::git_log,
            git_cmds::git_show_commit,
            git_cmds::git_commit_files,
            git_cmds::git_file_at,
            git_cmds::git_branches,
            git_cmds::git_checkout,
            git_cmds::git_push,
            git_cmds::git_pull,
            git_cmds::git_stage_all,
            ext_cmds::ext_import,
            ext_cmds::ext_install_url,
            ext_cmds::ext_uninstall,
            ext_cmds::ext_list,
            ext_cmds::ext_set_state,
            ext_cmds::ext_disabled_ids,
            ext_cmds::ext_marketplace,
            ext_cmds::ext_data_dir,
            ext_cmds::ext_path_exists,
            ext_cmds::ext_download,
            ext_cmds::ext_unzip,
            proc_cmds::proc_spawn,
            proc_cmds::proc_write,
            proc_cmds::proc_kill,
            ai_cmds::ai_models,
            git_cmds::git_merge,
            git_cmds::git_remote_url,
            git_cmds::git_default_branch,
            git_cmds::git_diff_all,
            ssh_cmds::ssh_connect,
            ssh_cmds::ssh_disconnect,
            ssh_cmds::ssh_list_dir,
            ssh_cmds::ssh_read_file,
            ssh_cmds::ssh_write_file,
            ssh_cmds::ssh_exec,
            ssh_cmds::ssh_forward_start,
            ssh_cmds::ssh_forward_stop,
            ai_cmds::ai_generate,
            gh_cmds::gh_api,
            gh_cmds::gh_device_start,
            gh_cmds::gh_device_poll,
            sys_cmds::detect_shells,
            sys_cmds::resolve_command,
            sys_cmds::launch_target,
            sys_cmds::register_context_menu,
            sys_cmds::unregister_context_menu,
            sys_cmds::install_cli,
            sys_cmds::detect_runtimes,
            sys_cmds::check_update,
            sys_cmds::open_url,
            tunnel_cmds::tunnel_start,
            tunnel_cmds::tunnel_stop,
            misc_cmds::settings_read,
            misc_cmds::settings_write,
            misc_cmds::run_formatter,
            pty_cmds::pty_spawn,
            pty_cmds::pty_write,
            pty_cmds::pty_resize,
            pty_cmds::pty_kill,
        ])
        .on_window_event(|window, event| {
            // closing the main window must kill every child process — no background
            // service left behind (pty shells, claude/node trees, ext host, tunnels)
            if matches!(event, tauri::WindowEvent::CloseRequested { .. } | tauri::WindowEvent::Destroyed) {
                use tauri::Manager;
                let app = window.app_handle();
                pty_cmds::kill_all(&app.state());
                proc_cmds::kill_all(&app.state());
                tunnel_cmds::kill_all(&app.state());
                if matches!(event, tauri::WindowEvent::CloseRequested { .. }) {
                    app.exit(0);
                    std::process::exit(0);
                }
            }
        })
        .run(tauri::generate_context!())
        .expect("error while running CozyCode");
}
