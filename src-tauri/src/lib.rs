use tauri::Manager;

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    let mut builder = tauri::Builder::default()
        .plugin(tauri_plugin_opener::init())
        .plugin(tauri_plugin_http::init())
        .plugin(tauri_plugin_fs::init());

    // android-fs uses MediaStore for public writes, bypassing scoped storage
    // restrictions that block std::fs on API 29+.
    #[cfg(target_os = "android")]
    {
        builder = builder.plugin(tauri_plugin_android_fs::init());
    }

    builder
        .setup(|app| {
            let mut window_builder = tauri::WebviewWindowBuilder::new(
                app,
                "main",
                tauri::WebviewUrl::App("index.html".into()),
            );

            #[cfg(desktop)]
            {
                window_builder = window_builder
                    .title("Lumi AI")
                    .inner_size(1024.0, 700.0)
                    .min_inner_size(360.0, 480.0)
                    .visible(false);
            }

            window_builder
                .build()
                .expect("failed to build main window");

            Ok(())
        })
        .invoke_handler(tauri::generate_handler![])
        .run(tauri::generate_context!())
        .expect("error while running tauri application");
}
