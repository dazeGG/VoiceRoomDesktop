'use strict';

(function exposeCatalog(root) {
  const catalogs = {
    ru: {
      unread: 'Непрочитанных: {count}', micOn: 'Включить микрофон', micOff: 'Выключить микрофон',
      soundOn: 'Включить звук', soundOff: 'Выключить звук', leave: 'Отключиться', inCall: 'VoiceRoom — в звонке',
      open: 'Открыть VoiceRoom', diagnostics: 'Диагностика', openLogs: 'Открыть папку логов',
      copySystem: 'Скопировать информацию о системе', quit: 'Выход', restartUpdate: 'Обновить и перезапустить',
      installUpdate: 'Установить обновление', installVersion: 'Установить обновление {version}',
      followLink: 'Перейти', cancel: 'Отмена', linkDetail: 'Текущий звонок прервётся.', linkQuestion: 'Перейти по ссылке?',
      noSuggestions: 'Нет вариантов', addDictionary: 'Добавить в словарь', copyLink: 'Копировать ссылку',
      copyImage: 'Копировать изображение', cut: 'Вырезать', copy: 'Копировать', paste: 'Вставить', selectAll: 'Выделить всё',
      streamAudio: 'Звук стрима', sourceGone: 'Выбранный источник больше недоступен.', noSources: 'Нет доступных источников экрана',
      you: 'Вы', participant: 'Участник', micMuted: 'Микрофон выключен', soundMuted: 'Звук выключен', stream: 'Стрим',
      updateError: 'Не удалось проверить или загрузить обновление.', checkingSite: 'Проверяем доступ к VoiceRoom...',
      siteUnavailable: 'Сайт VoiceRoom недоступен. Проверьте подключение к интернету.',
      proceedWithoutUpdate: 'Можно войти в приложение без обновления.', checkingUpdate: 'Проверка обновлений...',
      downloadingUpdate: 'Загрузка обновления...', installingUpdate: 'Установка обновления...',
      phaseBlocked: 'Нет доступа', phaseChecking: 'Запуск', phaseDownloading: 'Обновление', phaseInstalling: 'Установка',
      phaseSiteUnavailable: 'Сайт недоступен', phaseUpdateError: 'Ошибка обновления', enterApp: 'Войти в приложение', close: 'Закрыть',
      connectionTitle: 'Нет связи с сервером',
      connectionMessage: 'Не удаётся подключиться к VoiceRoom. Проверьте интернет. Приложение само откроется, когда связь появится.',
      checkNow: 'Проверить сейчас', recoveryTitle: 'Что-то пошло не так',
      recoveryMessage: 'Интерфейс VoiceRoom неожиданно остановился. Перезагрузите приложение, чтобы продолжить.', reload: 'Перезагрузить',
      pickerTitle: 'Выберите, что показать', sourceType: 'Тип источника', screens: 'Экраны', windows: 'Окна', sources: 'Источники',
      notSelected: 'Не выбрано', quality: 'Качество', streamSettings: 'Настройки стрима', streamMode: 'Режим стрима',
      smoothVideo: 'Плавное видео', smoothDetail: '30 к/с · для игр и видео', sharpPicture: 'Чёткая картинка', sharpDetail: '5 к/с · для текста и кода',
      windowAudioOnly: 'Только звук этого окна', start: 'Запустить', entireScreen: 'Весь экран',
      pickerError: 'Не удалось открыть выбор источника. Закройте окно и попробуйте снова.', fps: '{count} к/с',
      audioDetail: ' · звук', windowAudioDetail: ' · звук окна', sourceDetail: 'Источник', preview: 'Превью: {name}',
      previewTitle: 'VoiceRoom — выбор источника', previewError: 'Не удалось открыть preview\n\n{error}',
      missingUrl: 'Не задан VOICE_ROOM_URL. Создайте .env или electron/runtime-config.json.',
      macCaptureDenied: 'macOS не дала приложению доступ к записи экрана.', macCaptureStatus: 'Статус Screen Recording: {status}.',
      macCaptureSettings: 'Откройте System Settings → Privacy & Security → Screen & System Audio Recording и включите {appName}.{devHint}',
      macDevHint: ' При запуске через npm run electron разрешение может называться Electron.',
      macCaptureReadd: 'Если переключатель уже включён, удалите старую запись приложения кнопкой «−» и добавьте текущее приложение кнопкой «+».',
      macCaptureRestart: 'После изменения полностью закройте и снова откройте приложение.',
      about: 'О VoiceRoom', services: 'Службы', hide: 'Скрыть VoiceRoom', hideOthers: 'Скрыть остальные', showAll: 'Показать все',
      file: 'Файл', edit: 'Правка', view: 'Вид', window: 'Окно', undo: 'Отменить', redo: 'Повторить',
      forceReload: 'Перезагрузить без кеша', developerTools: 'Инструменты разработчика', actualSize: 'Исходный масштаб',
      zoomIn: 'Увеличить', zoomOut: 'Уменьшить', fullscreen: 'Полный экран', minimize: 'Свернуть', front: 'Все окна на передний план'
    },
    en: {
      unread: 'Unread: {count}', micOn: 'Unmute microphone', micOff: 'Mute microphone',
      soundOn: 'Enable sound', soundOff: 'Mute sound', leave: 'Disconnect', inCall: 'VoiceRoom — in a call',
      open: 'Open VoiceRoom', diagnostics: 'Diagnostics', openLogs: 'Open logs folder',
      copySystem: 'Copy system information', quit: 'Quit', restartUpdate: 'Update and restart',
      installUpdate: 'Install update', installVersion: 'Install update {version}',
      followLink: 'Open', cancel: 'Cancel', linkDetail: 'Your current call will end.', linkQuestion: 'Open this link?',
      noSuggestions: 'No suggestions', addDictionary: 'Add to dictionary', copyLink: 'Copy link',
      copyImage: 'Copy image', cut: 'Cut', copy: 'Copy', paste: 'Paste', selectAll: 'Select all',
      streamAudio: 'Stream audio', sourceGone: 'The selected source is no longer available.', noSources: 'No screen sources available',
      you: 'You', participant: 'Participant', micMuted: 'Microphone muted', soundMuted: 'Sound muted', stream: 'Stream',
      updateError: 'Could not check for or download the update.', checkingSite: 'Checking access to VoiceRoom...',
      siteUnavailable: 'VoiceRoom is unavailable. Check your internet connection.',
      proceedWithoutUpdate: 'You can enter the app without updating.', checkingUpdate: 'Checking for updates...',
      downloadingUpdate: 'Downloading update...', installingUpdate: 'Installing update...',
      phaseBlocked: 'Access unavailable', phaseChecking: 'Starting', phaseDownloading: 'Updating', phaseInstalling: 'Installing',
      phaseSiteUnavailable: 'Service unavailable', phaseUpdateError: 'Update error', enterApp: 'Enter the app', close: 'Close',
      connectionTitle: 'No connection to the server',
      connectionMessage: 'Cannot connect to VoiceRoom. Check your internet connection. The app will open automatically when the connection returns.',
      checkNow: 'Check now', recoveryTitle: 'Something went wrong',
      recoveryMessage: 'The VoiceRoom interface stopped unexpectedly. Reload the app to continue.', reload: 'Reload',
      pickerTitle: 'Choose what to share', sourceType: 'Source type', screens: 'Screens', windows: 'Windows', sources: 'Sources',
      notSelected: 'Not selected', quality: 'Quality', streamSettings: 'Stream settings', streamMode: 'Stream mode',
      smoothVideo: 'Smooth video', smoothDetail: '30 fps · for games and video', sharpPicture: 'Sharp picture', sharpDetail: '5 fps · for text and code',
      windowAudioOnly: 'Only audio from this window', start: 'Start', entireScreen: 'Entire screen',
      pickerError: 'Could not open the source picker. Close this window and try again.', fps: '{count} fps',
      audioDetail: ' · audio', windowAudioDetail: ' · window audio', sourceDetail: 'Source', preview: 'Preview: {name}',
      previewTitle: 'VoiceRoom — source picker', previewError: 'Could not open preview\n\n{error}',
      missingUrl: 'VOICE_ROOM_URL is not configured. Create .env or electron/runtime-config.json.',
      macCaptureDenied: 'macOS did not allow the app to record the screen.', macCaptureStatus: 'Screen Recording status: {status}.',
      macCaptureSettings: 'Open System Settings → Privacy & Security → Screen & System Audio Recording and enable {appName}.{devHint}',
      macDevHint: ' When launched with npm run electron, the permission may be named Electron.',
      macCaptureReadd: 'If it is already enabled, remove the old app entry with “−” and add the current app with “+”.',
      macCaptureRestart: 'Then fully quit and reopen the app.',
      about: 'About VoiceRoom', services: 'Services', hide: 'Hide VoiceRoom', hideOthers: 'Hide Others', showAll: 'Show All',
      file: 'File', edit: 'Edit', view: 'View', window: 'Window', undo: 'Undo', redo: 'Redo',
      forceReload: 'Force Reload', developerTools: 'Developer Tools', actualSize: 'Actual Size',
      zoomIn: 'Zoom In', zoomOut: 'Zoom Out', fullscreen: 'Full Screen', minimize: 'Minimize', front: 'Bring All to Front'
    },
    fr: {
      unread: 'Non lus : {count}', micOn: 'Activer le microphone', micOff: 'Couper le microphone',
      soundOn: 'Activer le son', soundOff: 'Couper le son', leave: 'Se déconnecter', inCall: 'VoiceRoom — en appel',
      open: 'Ouvrir VoiceRoom', diagnostics: 'Diagnostic', openLogs: 'Ouvrir le dossier des journaux',
      copySystem: 'Copier les informations système', quit: 'Quitter', restartUpdate: 'Mettre à jour et redémarrer',
      installUpdate: 'Installer la mise à jour', installVersion: 'Installer la mise à jour {version}',
      followLink: 'Ouvrir', cancel: 'Annuler', linkDetail: 'Votre appel actuel sera interrompu.', linkQuestion: 'Ouvrir ce lien ?',
      noSuggestions: 'Aucune suggestion', addDictionary: 'Ajouter au dictionnaire', copyLink: 'Copier le lien',
      copyImage: 'Copier l’image', cut: 'Couper', copy: 'Copier', paste: 'Coller', selectAll: 'Tout sélectionner',
      streamAudio: 'Son du partage', sourceGone: 'La source sélectionnée n’est plus disponible.', noSources: 'Aucune source d’écran disponible',
      you: 'Vous', participant: 'Participant', micMuted: 'Microphone coupé', soundMuted: 'Son coupé', stream: 'Partage',
      updateError: 'Impossible de vérifier ou de télécharger la mise à jour.', checkingSite: 'Vérification de l’accès à VoiceRoom...',
      siteUnavailable: 'VoiceRoom est indisponible. Vérifiez votre connexion Internet.',
      proceedWithoutUpdate: 'Vous pouvez ouvrir l’application sans la mettre à jour.', checkingUpdate: 'Recherche de mises à jour...',
      downloadingUpdate: 'Téléchargement de la mise à jour...', installingUpdate: 'Installation de la mise à jour...',
      phaseBlocked: 'Accès indisponible', phaseChecking: 'Démarrage', phaseDownloading: 'Mise à jour', phaseInstalling: 'Installation',
      phaseSiteUnavailable: 'Service indisponible', phaseUpdateError: 'Erreur de mise à jour', enterApp: 'Ouvrir l’application', close: 'Fermer',
      connectionTitle: 'Aucune connexion au serveur',
      connectionMessage: 'Impossible de se connecter à VoiceRoom. Vérifiez votre connexion Internet. L’application s’ouvrira automatiquement lorsque la connexion sera rétablie.',
      checkNow: 'Vérifier maintenant', recoveryTitle: 'Un problème est survenu',
      recoveryMessage: 'L’interface de VoiceRoom s’est arrêtée de manière inattendue. Rechargez l’application pour continuer.', reload: 'Recharger',
      pickerTitle: 'Choisissez ce que vous souhaitez partager', sourceType: 'Type de source', screens: 'Écrans', windows: 'Fenêtres', sources: 'Sources',
      notSelected: 'Aucune sélection', quality: 'Qualité', streamSettings: 'Paramètres du partage', streamMode: 'Mode de partage',
      smoothVideo: 'Vidéo fluide', smoothDetail: '30 i/s · pour les jeux et vidéos', sharpPicture: 'Image nette', sharpDetail: '5 i/s · pour le texte et le code',
      windowAudioOnly: 'Uniquement le son de cette fenêtre', start: 'Démarrer', entireScreen: 'Écran entier',
      pickerError: 'Impossible d’ouvrir le sélecteur de source. Fermez cette fenêtre et réessayez.', fps: '{count} i/s',
      audioDetail: ' · son', windowAudioDetail: ' · son de la fenêtre', sourceDetail: 'Source', preview: 'Aperçu : {name}',
      previewTitle: 'VoiceRoom — choix de la source', previewError: 'Impossible d’ouvrir l’aperçu\n\n{error}',
      missingUrl: 'VOICE_ROOM_URL n’est pas configuré. Créez .env ou electron/runtime-config.json.',
      macCaptureDenied: 'macOS n’a pas autorisé l’application à enregistrer l’écran.', macCaptureStatus: 'État de l’enregistrement de l’écran : {status}.',
      macCaptureSettings: 'Ouvrez Réglages Système → Confidentialité et sécurité → Enregistrement de l’écran et de l’audio système, puis activez {appName}.{devHint}',
      macDevHint: ' Si l’application est lancée avec npm run electron, l’autorisation peut porter le nom Electron.',
      macCaptureReadd: 'Si l’option est déjà activée, supprimez l’ancienne entrée avec « − » et ajoutez l’application actuelle avec « + ».',
      macCaptureRestart: 'Quittez ensuite complètement l’application et rouvrez-la.',
      about: 'À propos de VoiceRoom', services: 'Services', hide: 'Masquer VoiceRoom', hideOthers: 'Masquer les autres', showAll: 'Tout afficher',
      file: 'Fichier', edit: 'Édition', view: 'Présentation', window: 'Fenêtre', undo: 'Annuler', redo: 'Rétablir',
      forceReload: 'Recharger sans le cache', developerTools: 'Outils de développement', actualSize: 'Taille réelle',
      zoomIn: 'Agrandir', zoomOut: 'Réduire', fullscreen: 'Plein écran', minimize: 'Réduire la fenêtre', front: 'Tout ramener au premier plan'
    }
  };

  function isLocale(value) {
    return value === 'ru' || value === 'en' || value === 'fr';
  }

  function resolveLocale(preferences = []) {
    for (const value of preferences) {
      if (typeof value !== 'string') continue;
      const base = value.toLowerCase().split('-')[0];
      if (isLocale(base)) return base;
    }
    return 'ru';
  }

  function translate(locale, key, values = {}) {
    const message = catalogs[isLocale(locale) ? locale : 'ru'][key] ?? catalogs.ru[key] ?? key;
    return message.replace(/\{(\w+)\}/g, (_match, name) => String(values[name] ?? `{${name}}`));
  }

  const api = { catalogs, isLocale, resolveLocale, translate };
  if (typeof module !== 'undefined' && module.exports) module.exports = api;
  else root.voiceRoomCatalog = api;
})(globalThis);
